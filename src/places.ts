import { db, localDate, now } from "./db.ts";
import { closeVisitsFor } from "./location/geofence.ts";

export interface Place {
  id: number;
  name: string;
  logging_enabled: number;
  created_at: string;
  lat: number | null;
  lon: number | null;
  radius_m: number;
  /** entered_at of the open visit, if there is one. */
  here_since: string | null;
}

const SELECT = `
  SELECT p.id, p.name, p.logging_enabled, p.created_at, p.lat, p.lon, p.radius_m,
         (SELECT MIN(v.entered_at) FROM visits v WHERE v.place_id = p.id AND v.exited_at IS NULL) AS here_since
  FROM places p
  WHERE p.user_id = ? AND p.deleted_at IS NULL`;

export function listPlaces(userId: number): Place[] {
  return db().prepare(`${SELECT} ORDER BY p.name COLLATE NOCASE`).all(userId) as Place[];
}

export function getPlace(userId: number, id: number): Place | undefined {
  return db().prepare(`${SELECT} AND p.id = ?`).get(userId, id) as Place | undefined;
}

export function placeNameTaken(userId: number, name: string, exceptId = 0): boolean {
  return (
    db()
      .prepare("SELECT 1 FROM places WHERE user_id = ? AND lower(name) = lower(?) AND deleted_at IS NULL AND id != ?")
      .get(userId, name, exceptId) !== undefined
  );
}

export interface PlaceInput {
  name: string;
  lat: number | null;
  lon: number | null;
  radius_m: number;
}

export function createPlace(userId: number, p: PlaceInput): number {
  return Number(
    db()
      .prepare("INSERT INTO places (user_id, name, lat, lon, radius_m, logging_enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)")
      .run(userId, p.name, p.lat, p.lon, p.radius_m, now()).lastInsertRowid,
  );
}

/** Moving or resizing the geofence ends the open visit; the helper re-checks the new one. */
export function updatePlace(userId: number, id: number, p: PlaceInput): void {
  const d = db();
  d.transaction(() => {
    const before = getPlace(userId, id);
    if (!before) return;
    d.prepare("UPDATE places SET name = ?, lat = ?, lon = ?, radius_m = ? WHERE id = ? AND user_id = ?").run(
      p.name,
      p.lat,
      p.lon,
      p.radius_m,
      id,
      userId,
    );
    if (before.lat !== p.lat || before.lon !== p.lon || before.radius_m !== p.radius_m) closeVisitsFor(d, id);
  })();
}

export function setLogging(userId: number, id: number, on: boolean): void {
  const d = db();
  d.transaction(() => {
    d.prepare("UPDATE places SET logging_enabled = ? WHERE id = ? AND user_id = ?").run(on ? 1 : 0, id, userId);
    if (!on) closeVisitsFor(d, id);
  })();
}

/** Soft delete: visits stay, so the log still names the place. */
export function deletePlace(userId: number, id: number): void {
  const d = db();
  d.transaction(() => {
    d.prepare("UPDATE places SET deleted_at = ? WHERE id = ? AND user_id = ?").run(now(), id, userId);
    closeVisitsFor(d, id);
  })();
}

export interface Visit {
  id: number;
  place_id: number;
  place_name: string;
  entered_at: string;
  exited_at: string | null;
  source: string;
}

/** Visits overlapping [from, to), newest first. */
export function visits(userId: number, opts: { placeId?: number; from?: string; to?: string; limit?: number } = {}): Visit[] {
  const where = ["p.user_id = ?"];
  const args: unknown[] = [userId];
  if (opts.placeId) {
    where.push("v.place_id = ?");
    args.push(opts.placeId);
  }
  if (opts.to) {
    where.push("v.entered_at < ?");
    args.push(opts.to);
  }
  if (opts.from) {
    where.push("(v.exited_at IS NULL OR v.exited_at > ?)");
    args.push(opts.from);
  }
  args.push(opts.limit ?? 500);
  return db()
    .prepare(
      `SELECT v.id, v.place_id, p.name AS place_name, v.entered_at, v.exited_at, v.source
       FROM visits v JOIN places p ON p.id = v.place_id
       WHERE ${where.join(" AND ")} ORDER BY v.entered_at DESC LIMIT ?`,
    )
    .all(...args) as Visit[];
}

export const visitMs = (v: Visit, from?: string, to?: string): number => {
  const start = Math.max(Date.parse(v.entered_at), from ? Date.parse(from) : -Infinity);
  const end = Math.min(v.exited_at ? Date.parse(v.exited_at) : Date.now(), to ? Date.parse(to) : Infinity);
  return Math.max(0, end - start);
};

/** Monday-start weeks, most recent first: [weekStart YYYY-MM-DD, ms]. */
export function weeklyTotals(userId: number, placeId: number, weeks = 8): [string, number][] {
  const today = new Date();
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7));
  const out: [string, number][] = [];
  for (let i = 0; i < weeks; i++) {
    const start = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 7 * i);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
    const [f, t] = [start.toISOString(), end.toISOString()];
    const ms = visits(userId, { placeId, from: f, to: t }).reduce((sum, v) => sum + visitMs(v, f, t), 0);
    out.push([localDate(start), ms]);
  }
  return out;
}
