// Map for places, after loci: MapLibre GL with OpenFreeMap vector tiles, a
// draggable pin, the geofence drawn as a circle, and address search through
// /places/search (Nominatim). Loaded only on place pages. The coordinates and
// radius fields stay the source of truth, so the form works without it.
import type { Feature, FeatureCollection, Polygon } from "geojson";
import type * as ML from "maplibre-gl";

// Types come from the npm package; the module itself is served as is from
// /assets/maplibre (see server.tsx). A non-literal specifier keeps esbuild
// from bundling it.
const MAPLIBRE_URL = "/assets/maplibre/maplibre-gl.mjs";
let maplibregl: typeof ML;

type Point = { lat: number; lon: number };
type Theme = "light" | "dark";

/* Both styles carry POI layers (shops, transit), or the map reads as an empty
   street grid. OpenFreeMap has no dark style with POIs, so dark uses
   VersaTiles eclipse. */
const STYLES: Record<Theme, string> = {
  light: "https://tiles.openfreemap.org/styles/liberty",
  dark: "https://tiles.versatiles.org/assets/styles/eclipse/style.json",
};
// Both tile sources carry their own OpenStreetMap credits; VersaTiles' does
// not name VersaTiles itself.
const ATTRIBUTION: Record<Theme, string | undefined> = {
  light: undefined,
  dark: '<a href="https://versatiles.org" target="_blank" rel="noreferrer">VersaTiles</a>',
};
const BLUE = "#1d70b8";

const dark = matchMedia("(prefers-color-scheme: dark)");
function theme(): Theme {
  const t = document.documentElement.dataset.theme;
  if (t === "light" || t === "dark") return t;
  return dark.matches ? "dark" : "light";
}

/* eclipse draws POI icons without names; its poi-* layers already declare a
   font, so add a text field. */
async function loadStyle(t: Theme): Promise<string | ML.StyleSpecification> {
  if (t === "light") return STYLES.light;
  try {
    const style = (await (await fetch(STYLES.dark)).json()) as ML.StyleSpecification;
    for (const l of style.layers) {
      if (l.type !== "symbol" || !l.id.startsWith("poi-")) continue;
      l.layout = { ...l.layout, "text-field": ["get", "name"], "text-size": 11, "text-anchor": "top", "text-offset": [0, 0.9], "text-optional": true, "text-max-width": 9 };
      l.paint = { ...l.paint, "text-color": "#d8dde3", "text-halo-color": "rgba(0,0,0,0.85)", "text-halo-width": 1.2 };
    }
    return style;
  } catch {
    return STYLES.dark;
  }
}

// Same format as the server's parseCoords.
function parseCoords(s: string): Point | undefined {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s);
  if (!m) return;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : undefined;
}

/** A geofence as a 64-sided polygon (fine at these sizes; the Earth is round enough). */
function circle(c: Point, radiusM: number): Feature<Polygon> {
  const R = 6_371_000;
  const ring: [number, number][] = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    const dLat = ((radiusM * Math.cos(a)) / R) * (180 / Math.PI);
    const dLon = ((radiusM * Math.sin(a)) / (R * Math.cos((c.lat * Math.PI) / 180))) * (180 / Math.PI);
    ring.push([c.lon + dLon, c.lat + dLat]);
  }
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } };
}

function boundsOf(f: Feature<Polygon>): ML.LngLatBoundsLike {
  const ring = f.geometry.coordinates[0];
  const lons = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  return [
    [Math.min(...lons), Math.min(...lats)],
    [Math.max(...lons), Math.max(...lats)],
  ];
}

const num = (s: string | undefined) => (s === undefined || s === "" ? undefined : Number(s));

async function init(el: HTMLElement): Promise<void> {
  const editable = el.dataset.editable === "1";
  const coordsInput = document.getElementById("coords") as HTMLInputElement | null;
  const radiusInput = document.getElementById("radius") as HTMLInputElement | null;
  const hereLat = num(el.dataset.hereLat);
  const hereLon = num(el.dataset.hereLon);
  const here: Point | undefined = hereLat !== undefined && hereLon !== undefined ? { lat: hereLat, lon: hereLon } : undefined;

  let pin: Point | undefined = coordsInput ? parseCoords(coordsInput.value) : undefined;
  if (!pin && el.dataset.lat) pin = { lat: Number(el.dataset.lat), lon: Number(el.dataset.lon) };
  let radius = Number(radiusInput?.value || el.dataset.radius || 150);

  let t = theme();
  let map: ML.Map;
  try {
    maplibregl = (await import(MAPLIBRE_URL)) as typeof ML;
    map = new maplibregl.Map({
      container: el,
      style: await loadStyle(t),
      center: pin ? [pin.lon, pin.lat] : here ? [here.lon, here.lat] : [78.9, 21],
      zoom: pin ? 15 : here ? 15 : 3,
      attributionControl: false,
    });
  } catch {
    el.outerHTML = '<p class="govuk-body lg-muted">The map needs WebGL, which this browser has turned off. You can still type coordinates.</p>';
    return;
  }
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
  let attribution = new maplibregl.AttributionControl({ compact: true, customAttribution: ATTRIBUTION[t] });
  map.addControl(attribution);

  // ---------------------------------------------------------------- geofence circle

  const empty: FeatureCollection = { type: "FeatureCollection", features: [] };
  const shape = () => (pin && radius > 0 ? circle(pin, radius) : empty);
  const drawCircle = () => {
    const src = map.getSource("geofence") as ML.GeoJSONSource | undefined;
    if (src) src.setData(shape());
  };
  // Runs again after every setStyle, which drops custom layers.
  map.on("style.load", () => {
    if (map.getSource("geofence")) return;
    map.addSource("geofence", { type: "geojson", data: shape() });
    map.addLayer({ id: "geofence-fill", type: "fill", source: "geofence", paint: { "fill-color": BLUE, "fill-opacity": 0.15 } });
    map.addLayer({ id: "geofence-line", type: "line", source: "geofence", paint: { "line-color": BLUE, "line-width": 2 } });
  });
  if (pin) map.fitBounds(boundsOf(circle(pin, radius)), { padding: 40, duration: 0, maxZoom: 17 });

  if (here) {
    const dot = document.createElement("div");
    dot.className = "lg-you";
    dot.title = "This Mac";
    new maplibregl.Marker({ element: dot }).setLngLat([here.lon, here.lat]).addTo(map);
  }

  // ---------------------------------------------------------------- pin

  let marker: ML.Marker | undefined;
  const setPin = (p: Point, opts: { fly?: boolean; write?: boolean } = {}) => {
    pin = { lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) };
    if (!marker) {
      marker = new maplibregl.Marker({ draggable: editable, color: BLUE }).setLngLat([pin.lon, pin.lat]).addTo(map);
      marker.on("dragend", () => {
        const at = marker!.getLngLat();
        setPin({ lat: at.lat, lon: at.lng }, { write: true });
      });
    } else marker.setLngLat([pin.lon, pin.lat]);
    if (opts.write && coordsInput) coordsInput.value = `${pin.lat.toFixed(5)}, ${pin.lon.toFixed(5)}`;
    if (opts.fly) map.fitBounds(boundsOf(circle(pin, radius)), { padding: 40, maxZoom: 17 });
    drawCircle();
  };
  if (pin) setPin(pin);

  if (editable) {
    map.getCanvas().style.cursor = "crosshair";
    map.on("click", (e) => setPin({ lat: e.lngLat.lat, lon: e.lngLat.lng }, { write: true }));
    coordsInput?.addEventListener("change", () => {
      const p = coordsInput && parseCoords(coordsInput.value);
      if (p) setPin(p, { fly: true });
    });
    radiusInput?.addEventListener("input", () => {
      const r = Number(radiusInput.value);
      if (r > 0) {
        radius = r;
        drawCircle();
      }
    });
    // The server-side "Use this Mac's current location" reloads the page; with
    // the map we can just move the pin.
    document.querySelector<HTMLButtonElement>("button[name=locate]")?.addEventListener("click", (e) => {
      if (!here) return;
      e.preventDefault();
      setPin(here, { fly: true, write: true });
    });
    attachSearch((p) => setPin(p, { fly: true, write: true }));
  }

  // Follow the page theme when it tracks the system.
  dark.addEventListener("change", async () => {
    const next = theme();
    if (next === t) return;
    t = next;
    map.setStyle(await loadStyle(t));
    map.removeControl(attribution);
    attribution = new maplibregl.AttributionControl({ compact: true, customAttribution: ATTRIBUTION[t] });
    map.addControl(attribution);
  });
}

// ---------------------------------------------------------------- search

/** Nominatim asks for no more than one request a second: debounce, and the server throttles too. */
function attachSearch(onChoose: (p: Point) => void): void {
  const input = document.getElementById("place-search") as HTMLInputElement | null;
  const results = document.getElementById("place-results");
  const status = document.getElementById("place-search-status");
  if (!input || !results || !status) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  const hide = () => {
    results.hidden = true;
    results.innerHTML = "";
  };
  // Enter in the search box should search, not submit the place form.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.preventDefault();
    if (e.key === "Escape") hide();
  });
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) {
      hide();
      status.textContent = "";
      return;
    }
    timer = setTimeout(async () => {
      const mine = ++seq;
      status.textContent = "Searching…";
      let list: { name: string; lat: number; lon: number }[] = [];
      try {
        const res = await fetch(`/places/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) throw new Error(String(res.status));
        list = await res.json();
      } catch {
        if (mine === seq) status.textContent = "Search is not working right now. Click the map or type coordinates instead.";
        return;
      }
      if (mine !== seq) return;
      status.textContent = list.length ? `${list.length} ${list.length === 1 ? "result" : "results"}` : "No results";
      results.innerHTML = "";
      for (const item of list) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "lg-search__result";
        b.textContent = item.name;
        b.addEventListener("click", () => {
          hide();
          status.textContent = "";
          input.value = item.name.split(",")[0];
          onChoose({ lat: item.lat, lon: item.lon });
        });
        results.append(b);
      }
      results.hidden = list.length === 0;
    }, 600);
  });
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".lg-search")) hide();
  });
}

const el = document.getElementById("place-map");
if (el) void init(el);
