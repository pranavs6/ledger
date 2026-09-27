import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "../src/db.ts";

describe("migrations", () => {
  it("moves each task's and link's single domain into the join tables", () => {
    // A database as v0.1 left it: first migration only, single domain_id.
    const d = new Database(":memory:");
    d.pragma("foreign_keys = ON");
    d.exec(MIGRATIONS[0]);
    d.pragma("user_version = 1");
    d.exec(`
      INSERT INTO users (id, username, pw_hash, created_at) VALUES (1, 'u', 'x', '');
      INSERT INTO statuses (id, user_id, name, sort_order) VALUES (1, 1, 'Open', 0);
      INSERT INTO domains (id, user_id, name, sort_order) VALUES (7, 1, 'UI', 0);
      INSERT INTO tasks (id, user_id, title, status_id, domain_id, created_at, updated_at) VALUES (3, 1, 'a', 1, 7, '', '');
      INSERT INTO tasks (id, user_id, title, status_id, created_at, updated_at) VALUES (4, 1, 'b', 1, '', '');
      INSERT INTO links (id, user_id, title, url, domain_id, created_at, updated_at) VALUES (5, 1, 'l', 'https://x', 7, '', '');
    `);

    migrate(d);

    // Later migrations also ran: geofence columns exist, router tables are gone.
    expect(d.prepare("SELECT radius_m FROM places").all()).toEqual([]);
    expect(d.prepare("SELECT name FROM sqlite_master WHERE name = 'place_networks'").get()).toBeUndefined();

    expect(d.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(d.prepare("SELECT task_id, domain_id FROM task_domains").all()).toEqual([{ task_id: 3, domain_id: 7 }]);
    expect(d.prepare("SELECT link_id, domain_id FROM link_domains").all()).toEqual([{ link_id: 5, domain_id: 7 }]);
    expect(d.prepare("SELECT COUNT(*) AS n FROM tasks WHERE domain_id IS NOT NULL").get()).toEqual({ n: 0 });
  });
});
