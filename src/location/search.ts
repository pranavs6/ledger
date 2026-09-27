// Address search for the place map, through OpenStreetMap's Nominatim.
//
// Proxied rather than called from the browser so each request carries an
// identifying User-Agent, as Nominatim's usage policy asks, and so the
// policy's one-request-a-second limit holds however fast anyone types.
export interface SearchResult {
  name: string;
  lat: number;
  lon: number;
}

const ENDPOINT = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "Ledger/0.1 (personal work log on one Mac)";
const MIN_GAP_MS = 1100;
const CACHE_SIZE = 200;

const cache = new Map<string, SearchResult[]>();
let queue: Promise<unknown> = Promise.resolve();
let last = 0;

/** Runs `fn` no sooner than MIN_GAP_MS after the previous call finished starting. */
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = last + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return fn();
  });
  queue = run.catch(() => undefined);
  return run;
}

export async function searchPlaces(q: string): Promise<SearchResult[]> {
  const key = q.trim().toLowerCase();
  if (key.length < 3) return [];
  const hit = cache.get(key);
  if (hit) return hit;

  const url = `${ENDPOINT}?${new URLSearchParams({ q: q.trim(), format: "jsonv2", limit: "6" })}`;
  const res = await throttled(() =>
    fetch(url, { headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" }, signal: AbortSignal.timeout(10_000) }),
  );
  if (!res.ok) throw new Error(`Nominatim answered ${res.status}`);
  const rows = (await res.json()) as { display_name?: string; lat?: string; lon?: string }[];
  const results = rows
    .map((r) => ({ name: r.display_name ?? "", lat: Number(r.lat), lon: Number(r.lon) }))
    .filter((r) => r.name && Number.isFinite(r.lat) && Number.isFinite(r.lon));

  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
  cache.set(key, results);
  return results;
}

export const clearSearchCache = () => cache.clear();
