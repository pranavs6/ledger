// Visits from geofences.
//
// The Ledger Locator helper (helper/LedgerLocator.swift) watches each place's
// geofence through macOS Location Services and reports to /api/helper/report:
// a heartbeat, its permission status, its latest location, and whether it is
// inside or outside each geofence. This module turns those reports into
// visits.
//
// macOS does not deliver location events while the Mac sleeps. If the helper
// goes quiet for longer than STALE_MS, open visits are closed at its last
// check-in; on waking it re-checks every geofence and reopens where it still
// is.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.ts";
import type { DB } from "../db.ts";

export const SOURCE = "mac-location";
export const STALE_MS = 5 * 60_000;
export const MIN_RADIUS = 20;
export const MAX_RADIUS = 5000;

// ---------------------------------------------------------------- token

export const TOKEN_PATH = path.join(DATA_DIR, "helper-token");

let token: string | undefined;

/** The shared secret the helper sends; created (mode 600) on first use. */
export function helperToken(): string {
  if (token) return token;
  try {
    token = fs.readFileSync(TOKEN_PATH, "utf8").trim();
  } catch {
    fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true, mode: 0o700 });
    token = crypto.randomBytes(32).toString("base64url");
    fs.writeFileSync(TOKEN_PATH, `${token}\n`, { mode: 0o600 });
  }
  return token;
}

export const setHelperToken = (t: string) => {
  token = t;
};

export function tokenMatches(given: string | undefined): boolean {
  const want = Buffer.from(helperToken());
  const got = Buffer.from(given ?? "");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ---------------------------------------------------------------- geometry

/** Metres between two points (haversine). */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** "12.9716, 77.5946" as pasted from a map. */
export function parseCoords(s: string): { lat: number; lon: number } | undefined {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s);
  if (!m) return;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
  return { lat, lon };
}

export const fmtCoords = (lat: number, lon: number) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

// ---------------------------------------------------------------- helper state

export type AuthStatus = "authorized" | "denied" | "restricted" | "notDetermined" | "disabled";

export interface HelperState {
  last_seen_at: string | null;
  auth_status: AuthStatus | null;
  lat: number | null;
  lon: number | null;
  accuracy_m: number | null;
  located_at: string | null;
}

export function helperState(db: DB): HelperState {
  return db
    .prepare("SELECT last_seen_at, auth_status, lat, lon, accuracy_m, located_at FROM helper_state WHERE id = 1")
    .get() as HelperState;
}

export const helperAlive = (s: HelperState, now = Date.now()) =>
  !!s.last_seen_at && now - Date.parse(s.last_seen_at) <= STALE_MS;

// ---------------------------------------------------------------- reports

export interface Report {
  auth?: AuthStatus;
  location?: { lat: number; lon: number; accuracy: number; at: string };
  /** Inside or outside each geofence, oldest first. */
  states?: { place_id: number; inside: boolean; at: string }[];
}

export interface HelperPlace {
  id: number;
  lat: number;
  lon: number;
  radius: number;
}

/** Geofences for the helper to watch: every live place with logging on and a centre. */
export function watchedPlaces(db: DB): HelperPlace[] {
  return db
    .prepare(
      `SELECT id, lat, lon, radius_m AS radius FROM places
       WHERE deleted_at IS NULL AND logging_enabled = 1 AND lat IS NOT NULL AND lon IS NOT NULL ORDER BY id`,
    )
    .all() as HelperPlace[];
}

const iso = (s: string | undefined, fallback: Date) => {
  const t = s ? Date.parse(s) : Number.NaN;
  return Number.isNaN(t) ? fallback.toISOString() : new Date(t).toISOString();
};

export function applyReport(db: DB, report: Report, now = new Date()): void {
  db.transaction(() => {
    closeIfStale(db, now);
    const loc = report.location;
    const validLoc = loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon) && Math.abs(loc.lat) <= 90 && Math.abs(loc.lon) <= 180;
    db.prepare(
      `UPDATE helper_state SET last_seen_at = ?, auth_status = COALESCE(?, auth_status),
         lat = COALESCE(?, lat), lon = COALESCE(?, lon), accuracy_m = COALESCE(?, accuracy_m), located_at = COALESCE(?, located_at)
       WHERE id = 1`,
    ).run(
      now.toISOString(),
      report.auth ?? null,
      validLoc ? loc.lat : null,
      validLoc ? loc.lon : null,
      validLoc && Number.isFinite(loc.accuracy) ? loc.accuracy : null,
      validLoc ? iso(loc.at, now) : null,
    );
    for (const s of report.states ?? []) {
      if (Number.isInteger(s.place_id)) setInside(db, s.place_id, !!s.inside, iso(s.at, now), now.toISOString());
    }
  })();
}

/** `at` is when the helper saw the state change; `now` is this report. */
function setInside(db: DB, placeId: number, inside: boolean, at: string, now: string): void {
  const open = db.prepare("SELECT id FROM visits WHERE place_id = ? AND exited_at IS NULL").get(placeId) as { id: number } | undefined;
  if (!inside) {
    if (open) db.prepare("UPDATE visits SET exited_at = MAX(entered_at, ?) WHERE id = ?").run(at, open.id);
    return;
  }
  if (open) return;
  const place = db.prepare("SELECT logging_enabled FROM places WHERE id = ? AND deleted_at IS NULL").get(placeId) as
    | { logging_enabled: number }
    | undefined;
  if (!place?.logging_enabled) return;
  // The helper re-sends its states on every heartbeat, so "inside since 9am"
  // can arrive after a sleep closed that visit. Then all we know is that it
  // is inside now.
  const { last } = db.prepare("SELECT MAX(exited_at) AS last FROM visits WHERE place_id = ?").get(placeId) as { last: string | null };
  const start = last && last > at ? now : at;
  db.prepare("INSERT INTO visits (place_id, entered_at, source) VALUES (?, ?, ?)").run(placeId, start, SOURCE);
}

/** Closes open visits at the helper's last check-in if it has gone quiet (sleep, or not running). */
export function closeIfStale(db: DB, now = new Date()): void {
  const { last_seen_at } = helperState(db);
  if (last_seen_at && now.getTime() - Date.parse(last_seen_at) > STALE_MS) {
    db.prepare("UPDATE visits SET exited_at = MAX(entered_at, ?) WHERE exited_at IS NULL AND source = ?").run(last_seen_at, SOURCE);
  }
}

/** Closes the open visit to a place right away, e.g. when its logging is switched off. */
export function closeVisitsFor(db: DB, placeId: number, at = new Date()): void {
  db.prepare("UPDATE visits SET exited_at = ? WHERE place_id = ? AND exited_at IS NULL").run(at.toISOString(), placeId);
}

/** Runs closeIfStale every minute, so visits close even if the helper never comes back. */
export function startStaleCheck(db: DB): () => void {
  const timer = setInterval(() => closeIfStale(db), 60_000);
  return () => clearInterval(timer);
}
