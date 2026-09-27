import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DB_PATH } from "./config.ts";

export type DB = Database.Database;

// Each entry runs once, in order; PRAGMA user_version records how far we got.
// Never edit a shipped migration: append a new one.
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id         INTEGER PRIMARY KEY,
    username   TEXT NOT NULL UNIQUE,
    pw_hash    TEXT NOT NULL,
    theme      TEXT NOT NULL DEFAULT 'system',
    created_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    user_agent TEXT
  );
  CREATE TABLE login_failures (
    id INTEGER PRIMARY KEY,
    ip TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE TABLE audit (
    id      INTEGER PRIMARY KEY,
    user_id INTEGER,
    action  TEXT NOT NULL,
    detail  TEXT,
    ip      TEXT,
    at      TEXT NOT NULL
  );
  CREATE INDEX idx_failures_ip_at ON login_failures(ip, at);
  CREATE INDEX idx_audit_at ON audit(at);

  CREATE TABLE statuses (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    colour      TEXT NOT NULL DEFAULT 'grey',
    sort_order  INTEGER NOT NULL,
    is_closed   INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT
  );
  CREATE TABLE domains (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    colour      TEXT NOT NULL DEFAULT 'grey',
    sort_order  INTEGER NOT NULL,
    archived_at TEXT
  );

  CREATE TABLE journal_entries (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    entry_date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX idx_journal_user_date ON journal_entries(user_id, entry_date);

  CREATE TABLE tasks (
    id             INTEGER PRIMARY KEY,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title          TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    domain_id      INTEGER REFERENCES domains(id),
    timeline       TEXT NOT NULL DEFAULT '',
    status_id      INTEGER NOT NULL REFERENCES statuses(id),
    board_position REAL NOT NULL DEFAULT 0,
    assigned_at    TEXT,
    due_by         TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    deleted_at     TEXT
  );
  CREATE INDEX idx_tasks_user_status ON tasks(user_id, status_id);
  CREATE TABLE task_events (
    id             INTEGER PRIMARY KEY,
    task_id        INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    from_status_id INTEGER REFERENCES statuses(id),
    to_status_id   INTEGER NOT NULL REFERENCES statuses(id),
    at             TEXT NOT NULL
  );
  CREATE INDEX idx_task_events_task ON task_events(task_id, at);
  CREATE INDEX idx_task_events_at ON task_events(at);

  CREATE TABLE links (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    url         TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    domain_id   INTEGER REFERENCES domains(id),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
  );

  CREATE TABLE places (
    id              INTEGER PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    logging_enabled INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    deleted_at      TEXT
  );
  CREATE TABLE place_networks (
    id          INTEGER PRIMARY KEY,
    place_id    INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
    gateway_mac TEXT NOT NULL,
    ssid        TEXT,
    label       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    UNIQUE (place_id, gateway_mac)
  );
  CREATE TABLE visits (
    id         INTEGER PRIMARY KEY,
    place_id   INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
    entered_at TEXT NOT NULL,
    exited_at  TEXT,
    source     TEXT NOT NULL
  );
  CREATE INDEX idx_visits_place ON visits(place_id, entered_at);
  CREATE INDEX idx_visits_open ON visits(exited_at) WHERE exited_at IS NULL;
  CREATE TABLE detector_state (
    id               INTEGER PRIMARY KEY CHECK (id = 1),
    last_seen_at     TEXT,
    last_key         TEXT,
    last_fingerprint TEXT
  );
  INSERT INTO detector_state (id) VALUES (1);
  `,
  // Tasks and links can have several domains. The old single domain_id
  // columns stay (SQLite cannot drop a column that has a foreign key) but are
  // no longer read or written.
  `
  CREATE TABLE task_domains (
    task_id   INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, domain_id)
  );
  CREATE TABLE link_domains (
    link_id   INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    PRIMARY KEY (link_id, domain_id)
  );
  CREATE INDEX idx_task_domains_domain ON task_domains(domain_id);
  CREATE INDEX idx_link_domains_domain ON link_domains(domain_id);
  INSERT INTO task_domains (task_id, domain_id) SELECT id, domain_id FROM tasks WHERE domain_id IS NOT NULL;
  INSERT INTO link_domains (link_id, domain_id) SELECT id, domain_id FROM links WHERE domain_id IS NOT NULL;
  UPDATE tasks SET domain_id = NULL;
  UPDATE links SET domain_id = NULL;
  `,
  // Places become geofences watched by the Ledger Locator helper; the
  // router-based detector and its tables go.
  `
  UPDATE visits SET exited_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE exited_at IS NULL;
  DROP TABLE place_networks;
  DROP TABLE detector_state;
  ALTER TABLE places ADD COLUMN lat REAL;
  ALTER TABLE places ADD COLUMN lon REAL;
  ALTER TABLE places ADD COLUMN radius_m INTEGER NOT NULL DEFAULT 150;
  CREATE TABLE helper_state (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    last_seen_at TEXT,
    auth_status  TEXT,
    lat          REAL,
    lon          REAL,
    accuracy_m   REAL,
    located_at   TEXT
  );
  INSERT INTO helper_state (id) VALUES (1);
  `,
];

export function migrate(db: DB): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export function openDb(file: string = DB_PATH): DB {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Create the file 600 before SQLite opens it: SQLite copies the main
    // file's mode onto -wal and -shm, so a chmod afterwards is too late.
    fs.closeSync(fs.openSync(file, "a", 0o600));
    fs.chmodSync(file, 0o600);
  }
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

let shared: DB | undefined;
export const db = (): DB => (shared ??= openDb());
export const setDb = (d: DB) => {
  shared = d;
};

export const now = () => new Date().toISOString();

/** Local calendar date as YYYY-MM-DD. */
export function localDate(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** UTC ISO bounds of a local calendar day, for querying ISO timestamps. */
export function dayBounds(date: string): [string, string] {
  const [y, m, d] = date.split("-").map(Number);
  return [new Date(y, m - 1, d).toISOString(), new Date(y, m - 1, d + 1).toISOString()];
}

export const isDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** A LIKE pattern for a substring search; use with `ESCAPE '\'`. */
export const likeArg = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
