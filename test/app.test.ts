import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../src/auth.ts";
import { db, localDate } from "../src/db.ts";
import { applyReport, setHelperToken } from "../src/location/geofence.ts";
import { clearSearchCache } from "../src/location/search.ts";
import { createApp } from "../src/server.tsx";
import { withUser } from "./helpers.ts";

const app = createApp({ host: "127.0.0.1" });
const BASE = "http://localhost:4545";
let cookie = "";
let userId = 0;

setHelperToken("test-helper-token");

function req(path: string, init: RequestInit & { form?: Record<string, string>; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", "localhost:4545");
  if (cookie) headers.set("cookie", cookie);
  let body = init.body;
  if (init.form) {
    headers.set("content-type", "application/x-www-form-urlencoded");
    headers.set("origin", BASE);
    body = new URLSearchParams(init.form).toString();
  }
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    headers.set("origin", BASE);
    body = JSON.stringify(init.json);
  }
  return app.request(`${BASE}${path}`, { ...init, headers, body, method: init.method ?? (body ? "POST" : "GET") });
}

const statusId = (name: string) =>
  (db().prepare("SELECT id FROM statuses WHERE user_id = ? AND name = ?").get(userId, name) as { id: number }).id;

beforeEach(async () => {
  ({ userId } = await withUser());
  cookie = `ledger_session=${createSession(userId).token}`;
});

describe("security", () => {
  it("redirects to sign in without a session", async () => {
    cookie = "";
    const res = await req("/tasks/board");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?next=%2Ftasks%2Fboard");
  });

  it("refuses a foreign Host header (DNS rebinding)", async () => {
    const res = await app.request(`${BASE}/login`, { headers: { host: "evil.example" } });
    expect(res.status).toBe(403);
  });

  it("refuses cross-origin POSTs", async () => {
    const res = await req("/journal", {
      method: "POST",
      headers: { origin: "http://evil.example", "content-type": "application/x-www-form-urlencoded" },
      body: "title=x&entry_date=2026-09-27",
    });
    expect(res.status).toBe(403);
  });

  it("signs in with the right password only", async () => {
    cookie = "";
    const bad = await req("/login", { form: { username: "pranav", password: "wrong", next: "/" } });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("Enter a correct username and password");
    const good = await req("/login", { form: { username: "pranav", password: "correct horse", next: "/tasks" } });
    expect(good.status).toBe(302);
    expect(good.headers.get("location")).toBe("/tasks");
    expect(good.headers.get("set-cookie")).toMatch(/ledger_session=.+HttpOnly/);
  });

  it("never serves the GDS Transport font files", async () => {
    const res = await req("/assets/fonts/bold-b542beb274-v2.woff2");
    expect(res.status).toBe(404);
    expect((await req("/assets/govuk-frontend.min.css")).status).toBe(200);
  });
});

describe("pages", () => {
  it("renders every top-level page", async () => {
    for (const path of ["/", "/journal", "/tasks", "/tasks/board", "/tasks/new", "/links", "/places", "/places/log", "/settings/statuses", "/settings/domains", "/profile", "/activity"]) {
      const res = await req(path);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain('class="govuk-template"');
    }
  });

  it("shows GDS validation errors", async () => {
    const res = await req("/tasks", { form: { title: "", status_id: "" } });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("There is a problem");
    expect(html).toContain("Enter a title");
    expect(html).toContain("<title>Error: Add a task - Ledger</title>");
  });
});

describe("tasks", () => {
  it("creates, moves on the board, and records history on the day view", async () => {
    const created = await req("/tasks", {
      form: { title: "Fix payout bug", description: "**urgent**", status_id: String(statusId("Yet to begin")), timeline: "Sprint 42", due_by: "2026-10-01" },
    });
    expect(created.status).toBe(302);
    const id = Number(created.headers.get("location")!.split("/").pop());

    const moved = await req(`/tasks/${id}/status`, { json: { status_id: statusId("In review"), order: [id] } });
    expect(await moved.json()).toEqual({ ok: true });

    const detail = await (await req(`/tasks/${id}`)).text();
    expect(detail).toContain("<strong>urgent</strong>");
    expect(detail).toContain("Sprint 42");
    expect(detail).toMatch(/Yet to begin.*→.*In review/s);

    const day = await (await req(`/journal/day/${localDate()}`)).text();
    expect(day).toContain("Fix payout bug");
    expect(day).toContain("Moved to");

    const board = await (await req("/tasks/board")).text();
    expect(board).toContain(`data-id="${id}"`);
  });

  it("moves without JS through the form", async () => {
    const created = await req("/tasks", { form: { title: "Plain form", status_id: String(statusId("Yet to begin")) } });
    const id = Number(created.headers.get("location")!.split("/").pop());
    const res = await req(`/tasks/${id}/status`, { form: { status_id: String(statusId("Done")), back: "/tasks/board" } });
    expect(res.headers.get("location")).toBe("/tasks/board");
    const row = db().prepare("SELECT status_id FROM tasks WHERE id = ?").get(id) as { status_id: number };
    expect(row.status_id).toBe(statusId("Done"));
  });

  it("strips script from Markdown", async () => {
    const created = await req("/tasks", { form: { title: "x", description: "<script>alert(1)</script><img src=x onerror=alert(1)>", status_id: String(statusId("Yet to begin")) } });
    const html = await (await req(created.headers.get("location")!)).text();
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("onerror");
  });

  it("adds a custom status that shows up as a board column", async () => {
    await req("/settings/statuses", { form: { name: "Blocked", colour: "red" } });
    const board = await (await req("/tasks/board")).text();
    expect(board).toContain("Blocked");
  });

  it("will not archive a status that still has tasks", async () => {
    await req("/tasks", { form: { title: "Busy", status_id: String(statusId("In progress")) } });
    const res = await req(`/settings/statuses/${statusId("In progress")}/archive`, { method: "POST", headers: { origin: BASE } });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Move the 1 task in In progress");
  });
});

describe("domains and popups", () => {
  const domainId = (name: string) =>
    (db().prepare("SELECT id FROM domains WHERE user_id = ? AND name = ?").get(userId, name) as { id: number } | undefined)?.id;

  it("gives a task several domains and creates new ones inline", async () => {
    const body = new URLSearchParams({ title: "Multi", status_id: String(statusId("Yet to begin")), new_domains: "Infra, SRE" });
    body.append("domain_ids", String(domainId("UI")));
    body.append("domain_ids", String(domainId("Analytics")));
    const res = await req("/tasks", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
      body: body.toString(),
    });
    expect(res.status).toBe(302);
    const id = Number(res.headers.get("location")!.split("/").pop());
    const names = db()
      .prepare("SELECT d.name FROM task_domains x JOIN domains d ON d.id = x.domain_id WHERE x.task_id = ? ORDER BY d.sort_order")
      .all(id)
      .map((r: any) => r.name);
    expect(names).toEqual(["UI", "Analytics", "Infra", "SRE"]);

    const filtered = await (await req(`/tasks?domain=${domainId("SRE")}`)).text();
    expect(filtered).toContain("Multi");
    const other = await (await req(`/tasks?domain=${domainId("App")}`)).text();
    expect(other).not.toContain("Multi");
  });

  it("does not create new domains when the form has errors", async () => {
    const res = await req("/tasks", { form: { title: "", status_id: String(statusId("Yet to begin")), new_domains: "Ghost" } });
    expect(res.status).toBe(400);
    expect(domainId("Ghost")).toBeUndefined();
    expect(await res.text()).toContain('value="Ghost"');
  });

  it("renders only the content for the popup", async () => {
    const res = await req("/tasks/new", { headers: { "x-ledger-partial": "1" } });
    const html = await res.text();
    expect(html.startsWith('<div class="lg-partial" data-title="Add a task">')).toBe(true);
    expect(html).not.toContain("<html");
  });

  it("adds a board column with just a name", async () => {
    const res = await req("/settings/statuses", { form: { name: "Blocked", back: "/tasks/board" } });
    expect(res.headers.get("location")).toBe("/tasks/board");
    const row = db().prepare("SELECT colour FROM statuses WHERE user_id = ? AND name = 'Blocked'").get(userId) as { colour: string };
    expect(row.colour).toBeTruthy();
  });

  it("keeps settings out of the menu", async () => {
    const html = await (await req("/")).text();
    expect(html).not.toContain('href="/settings/statuses"');
    expect(await (await req("/tasks/board")).text()).toContain('href="/settings/statuses" data-modal');
  });
});

describe("places", () => {
  const addOffice = () => req("/places", { form: { name: "Office", coords: "12.9716, 77.5946", radius: "150" } });

  it("adds a place with a geofence", async () => {
    const res = await addOffice();
    expect(res.status).toBe(302);
    const row = db().prepare("SELECT lat, lon, radius_m FROM places WHERE name = 'Office'").get();
    expect(row).toEqual({ lat: 12.9716, lon: 77.5946, radius_m: 150 });
  });

  it("validates coordinates and radius", async () => {
    const res = await req("/places", { form: { name: "X", coords: "somewhere", radius: "10" } });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Enter coordinates as latitude, longitude");
    expect(html).toContain("Radius must be a whole number of metres between 50 and 5000");
  });

  it("fills in this Mac's location from the helper", async () => {
    applyReport(db(), { auth: "authorized", location: { lat: 51.5033, lon: -0.1196, accuracy: 35, at: new Date().toISOString() } });
    const res = await req("/places", { form: { name: "Eye", coords: "", radius: "150", locate: "1" } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('value="51.50330, -0.11960"');
    expect(db().prepare("SELECT COUNT(*) AS n FROM places").get()).toEqual({ n: 0 });
  });

  it("says when the helper is not running", async () => {
    expect(await (await req("/places")).text()).toContain("Ledger Locator is not running");
  });

  it("still says where this Mac is when logging is off", async () => {
    const placeId = Number((await addOffice()).headers.get("location")!.split("/").pop());
    await req(`/places/${placeId}/logging`, { form: { on: "0" } });
    applyReport(db(), { auth: "authorized", location: { lat: 12.9716, lon: 77.5946, accuracy: 30, at: new Date().toISOString() } });
    const html = await (await req("/places")).text();
    expect(html).toContain("This Mac is at <strong>Office</strong>");
    expect(html).toContain("Logging is off for Office");
    expect(html).toContain("Here, not logging");
  });

  it("turns logging off", async () => {
    const placeId = Number((await addOffice()).headers.get("location")!.split("/").pop());
    await req(`/places/${placeId}/logging`, { form: { on: "0" } });
    const p = db().prepare("SELECT logging_enabled FROM places WHERE id = ?").get(placeId) as { logging_enabled: number };
    expect(p.logging_enabled).toBe(0);
  });
});

describe("map", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearSearchCache();
  });

  it("serves MapLibre's own files and nothing else from its folder", async () => {
    const js = await req("/assets/maplibre/maplibre-gl.mjs");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect((await req("/assets/maplibre/package.json")).status).toBe(404);
  });

  it("loads the map only on place pages", async () => {
    expect(await (await req("/places/new")).text()).toContain("/static/build/map.js");
    expect(await (await req("/tasks")).text()).not.toContain("/static/build/map.js");
  });

  it("proxies address search to Nominatim with a User-Agent, and caches it", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{ display_name: "MTI, Chennai, Tamil Nadu, India", lat: "12.9824", lon: "80.2015" }])),
    );
    const res = await req("/places/search?q=MTI%20Chennai");
    expect(await res.json()).toEqual([{ name: "MTI, Chennai, Tamil Nadu, India", lat: 12.9824, lon: 80.2015 }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("nominatim.openstreetmap.org/search?q=MTI+Chennai");
    expect((init?.headers as Record<string, string>)["User-Agent"]).toMatch(/^Ledger\//);
    await req("/places/search?q=mti%20chennai");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a search failure without crashing the page", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("busy", { status: 503 }));
    const res = await req("/places/search?q=somewhere");
    expect(res.status).toBe(502);
  });
});

describe("helper API", () => {
  const api = (path: string, init: RequestInit = {}, token = "test-helper-token") =>
    app.request(`${BASE}/api/helper${path}`, {
      ...init,
      headers: { host: "127.0.0.1:4545", authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
    });

  it("refuses a wrong token", async () => {
    expect((await api("/places", {}, "nope")).status).toBe(401);
  });

  it("takes a report, logs a visit and returns the geofences to watch", async () => {
    await req("/places", { form: { name: "Office", coords: "12.9716, 77.5946", radius: "200" } });
    const placeId = (db().prepare("SELECT id FROM places WHERE name = 'Office'").get() as { id: number }).id;
    const res = await api("/report", {
      method: "POST",
      body: JSON.stringify({
        auth: "authorized",
        location: { lat: 12.9717, lon: 77.5947, accuracy: 30, at: new Date().toISOString() },
        states: [{ place_id: placeId, inside: true, at: new Date().toISOString() }],
      }),
    });
    expect(await res.json()).toEqual({ places: [{ id: placeId, lat: 12.9716, lon: 77.5946, radius: 200 }] });
    expect((await (await req("/places")).text())).toContain("This Mac is at <strong>Office</strong>");
    expect(await (await req(`/places/${placeId}`)).text()).toMatch(/\d+ m from the centre, inside the geofence/);
  });
});
