import { db, localDate, now } from "./db.ts";
import { closeVisitsFor } from "./location/detector.ts";
import type { Fingerprint } from "./location/fingerprint.ts";

export interface Place {
  id: number;
  name: string;
  logging_enabled: number;
  created_at: string;
  networks: number;
  /** entered_at of the open visit, if there is one. */
  here_since: string | null;
}

const SELECT = `
  SELECT p.id, p.name, p.logging_enabled, p.created_at,
         (SELECT COUNT(*) FROM place_networks n WHERE n.place_id = p.id) AS networks,
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

export function createPlace(userId: number, name: string): number {
  return Number(
    db().prepare("INSERT INTO places (user_id, name, logging_enabled, created_at) VALUES (?, ?, 1, ?)").run(userId, name, now())
      .lastInsertRowid,
  );
}

export function renamePlace(userId: number, id: number, name: string): void {
  db().prepare("UPDATE places SET name = ? WHERE id = ? AND user_id = ?").run(name, id, userId);
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

export interface Network {
  id: number;
  gateway_mac: string;
  ssid: string | null;
  label: string;
  created_at: string;
}

export function placeNetworks(placeId: number): Network[] {
  return db()
    .prepare("SELECT id, gateway_mac, ssid, label, created_at FROM place_networks WHERE place_id = ? ORDER BY created_at")
    .all(placeId) as Network[];
}

export function addNetwork(placeId: number, fp: Fingerprint, label: string): boolean {
  if (!fp.gatewayMac) return false;
  db()
    .prepare(
      `INSERT INTO place_networks (place_id, gateway_mac, ssid, label, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (place_id, gateway_mac) DO UPDATE SET ssid = COALESCE(excluded.ssid, ssid), label = excluded.label`,
    )
    .run(placeId, fp.gatewayMac, fp.ssid ?? null, label, now());
  return true;
}

export function removeNetwork(placeId: number, networkId: number): void {
  db().prepare("DELETE FROM place_networks WHERE id = ? AND place_id = ?").run(networkId, placeId);
}

/** Live places of this user that already claim a gateway. */
export function placesForGateway(userId: number, mac: string): { id: number; name: string }[] {
  return db()
    .prepare(
      `SELECT DISTINCT p.id, p.name FROM places p JOIN place_networks n ON n.place_id = p.id
       WHERE p.user_id = ? AND p.deleted_at IS NULL AND n.gateway_mac = ?`,
    )
    .all(userId, mac) as { id: number; name: string }[];
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
