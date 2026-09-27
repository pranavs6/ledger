// Turns network fingerprints into visits.
//
// Each tick reads the fingerprint. A key only counts once it has been seen on
// two ticks in a row, so a Wi-Fi roam or a dropped DHCP lease does not split a
// visit. Once stable, the open visits are reconciled against the places whose
// networks match: visits to places no longer matched are closed, and matched
// places with logging on get a visit opened. Changes are timestamped at the
// first sighting, not at confirmation.
//
// A gap of more than SLEEP_GAP_MS between ticks means the Mac was asleep (or
// the server was down): open visits are closed at the last tick before it.
import fs from "node:fs";
import type { DB } from "../db.ts";
import { type Fingerprint, fingerprintKey, readFingerprint } from "./fingerprint.ts";

export const POLL_MS = 30_000;
export const SLEEP_GAP_MS = 5 * 60_000;
export const SOURCE = "mac-network";

interface State {
  last_seen_at: string | null;
  last_key: string | null;
}

export function step(db: DB, at: Date, fp: Fingerprint): void {
  const key = fingerprintKey(fp);
  const iso = at.toISOString();
  db.transaction(() => {
    const state = db.prepare("SELECT last_seen_at, last_key FROM detector_state WHERE id = 1").get() as State;
    let prevKey = state.last_key;

    if (state.last_seen_at && at.getTime() - Date.parse(state.last_seen_at) > SLEEP_GAP_MS) {
      closeAllOpen(db, state.last_seen_at);
      prevKey = null; // stale: make the current network prove itself again
    }

    if (key === prevKey) reconcile(db, key, state.last_seen_at ?? iso);

    db.prepare("UPDATE detector_state SET last_seen_at = ?, last_key = ?, last_fingerprint = ? WHERE id = 1").run(
      iso,
      key,
      JSON.stringify(fp),
    );
  })();
}

function closeAllOpen(db: DB, at: string): void {
  db.prepare("UPDATE visits SET exited_at = ? WHERE exited_at IS NULL AND source = ?").run(at, SOURCE);
}

/** Make the open visits match the places for `key`. `at` is when the key was first seen. */
function reconcile(db: DB, key: string | null, at: string): void {
  const matched = new Set(
    key === null
      ? []
      : (
          db
            .prepare(
              `SELECT DISTINCT p.id FROM places p JOIN place_networks n ON n.place_id = p.id
               WHERE n.gateway_mac = ? AND p.deleted_at IS NULL AND p.logging_enabled = 1`,
            )
            .all(key) as { id: number }[]
        ).map((r) => r.id),
  );
  const open = db.prepare("SELECT id, place_id FROM visits WHERE exited_at IS NULL AND source = ?").all(SOURCE) as {
    id: number;
    place_id: number;
  }[];

  const close = db.prepare("UPDATE visits SET exited_at = ? WHERE id = ?");
  for (const v of open) {
    if (matched.has(v.place_id)) matched.delete(v.place_id);
    else close.run(at, v.id);
  }
  const insert = db.prepare("INSERT INTO visits (place_id, entered_at, source) VALUES (?, ?, ?)");
  for (const placeId of matched) insert.run(placeId, at, SOURCE);
}

export function lastFingerprint(db: DB): { fingerprint: Fingerprint; seenAt: string | null } {
  const row = db.prepare("SELECT last_fingerprint, last_seen_at FROM detector_state WHERE id = 1").get() as {
    last_fingerprint: string | null;
    last_seen_at: string | null;
  };
  return { fingerprint: row.last_fingerprint ? JSON.parse(row.last_fingerprint) : {}, seenAt: row.last_seen_at };
}

/** Closes the open visit to a place right away, e.g. when its logging is switched off. */
export function closeVisitsFor(db: DB, placeId: number, at = new Date()): void {
  db.prepare("UPDATE visits SET exited_at = ? WHERE place_id = ? AND exited_at IS NULL").run(at.toISOString(), placeId);
}

export class Detector {
  private timer?: NodeJS.Timeout;
  private watcher?: fs.FSWatcher;
  private burst: NodeJS.Timeout[] = [];
  private running = false;

  constructor(
    private db: DB,
    private read: () => Promise<Fingerprint> = readFingerprint,
    private log: (msg: string) => void = (m) => console.log(`[detector] ${m}`),
  ) {}

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      step(this.db, new Date(), await this.read());
    } catch (e) {
      this.log(`tick failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    try {
      // Changes whenever the network does. Two quick ticks confirm the new key
      // without waiting a full minute for two polls.
      this.watcher = fs.watch("/Library/Preferences/SystemConfiguration", () => {
        this.burst.forEach(clearTimeout);
        this.burst = [setTimeout(() => void this.tick(), 3000), setTimeout(() => void this.tick(), 8000)];
      });
    } catch {
      this.log("cannot watch SystemConfiguration; polling only");
    }
  }

  stop(): void {
    clearInterval(this.timer);
    this.burst.forEach(clearTimeout);
    this.watcher?.close();
  }
}
