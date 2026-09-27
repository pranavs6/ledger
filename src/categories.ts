// Statuses and domains: per-user, ordered, coloured, archivable lists.
import { db, now } from "./db.ts";

export type Kind = "statuses" | "domains";

export interface Category {
  id: number;
  name: string;
  colour: string;
  sort_order: number;
  is_closed: number; // always 0 for domains
  archived_at: string | null;
}

const cols = (kind: Kind) =>
  `id, name, colour, sort_order, ${kind === "statuses" ? "is_closed" : "0 AS is_closed"}, archived_at`;

export function listCategories(kind: Kind, userId: number, includeArchived = false): Category[] {
  return db()
    .prepare(
      `SELECT ${cols(kind)} FROM ${kind} WHERE user_id = ? ${includeArchived ? "" : "AND archived_at IS NULL"}
       ORDER BY archived_at IS NOT NULL, sort_order, id`,
    )
    .all(userId) as Category[];
}

export function getCategory(kind: Kind, userId: number, id: number): Category | undefined {
  return db().prepare(`SELECT ${cols(kind)} FROM ${kind} WHERE user_id = ? AND id = ?`).get(userId, id) as
    | Category
    | undefined;
}

export function nameTaken(kind: Kind, userId: number, name: string, exceptId = 0): boolean {
  return (
    db()
      .prepare(`SELECT 1 FROM ${kind} WHERE user_id = ? AND lower(name) = lower(?) AND archived_at IS NULL AND id != ?`)
      .get(userId, name, exceptId) !== undefined
  );
}

/** Picks the next colour for a new status or domain, cycling through the palette. */
export function nextColour(kind: Kind, userId: number): string {
  return AUTO_COLOURS[listCategories(kind, userId, true).length % AUTO_COLOURS.length];
}

export function addCategory(kind: Kind, userId: number, name: string, colour: string, closed: boolean): number {
  const { next } = db().prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM ${kind} WHERE user_id = ?`).get(userId) as {
    next: number;
  };
  const r =
    kind === "statuses"
      ? db()
          .prepare("INSERT INTO statuses (user_id, name, colour, sort_order, is_closed) VALUES (?, ?, ?, ?, ?)")
          .run(userId, name, colour, next, closed ? 1 : 0)
      : db().prepare("INSERT INTO domains (user_id, name, colour, sort_order) VALUES (?, ?, ?, ?)").run(userId, name, colour, next);
  return Number(r.lastInsertRowid);
}

export function updateCategory(kind: Kind, userId: number, id: number, name: string, colour: string, closed: boolean): void {
  if (kind === "statuses") {
    db()
      .prepare("UPDATE statuses SET name = ?, colour = ?, is_closed = ? WHERE id = ? AND user_id = ?")
      .run(name, colour, closed ? 1 : 0, id, userId);
  } else {
    db().prepare("UPDATE domains SET name = ?, colour = ? WHERE id = ? AND user_id = ?").run(name, colour, id, userId);
  }
}

/** Swaps with the neighbour above (-1) or below (+1) among live rows. */
export function moveCategory(kind: Kind, userId: number, id: number, dir: -1 | 1): void {
  const d = db();
  d.transaction(() => {
    const list = listCategories(kind, userId);
    const i = list.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    const set = d.prepare(`UPDATE ${kind} SET sort_order = ? WHERE id = ?`);
    list.forEach((x, n) => set.run(n, x.id));
  })();
}

export function usage(kind: Kind, userId: number, id: number): number {
  const sql =
    kind === "statuses"
      ? "SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND status_id = ? AND deleted_at IS NULL"
      : `SELECT COUNT(*) AS n FROM task_domains td JOIN tasks t ON t.id = td.task_id
         WHERE t.user_id = ? AND td.domain_id = ? AND t.deleted_at IS NULL`;
  return (db().prepare(sql).get(userId, id) as { n: number }).n;
}

// ---------------------------------------------------------------- domains on tasks and links

export interface DomainRef {
  id: number;
  name: string;
  colour: string;
}

/** A correlated subquery giving a row's domains as JSON, in domain order. */
export const domainsJson = (join: "task_domains" | "link_domains", key: "task_id" | "link_id", idExpr: string) => `
  (SELECT json_group_array(json_object('id', id, 'name', name, 'colour', colour)) FROM (
     SELECT d.id, d.name, d.colour FROM ${join} x JOIN domains d ON d.id = x.domain_id
     WHERE x.${key} = ${idExpr} ORDER BY d.sort_order, d.id))`;

export const parseDomains = (json: string | null): DomainRef[] => (json ? JSON.parse(json) : []);

/** Checkbox values (comma-joined ids) that name live domains of this user; undefined if any does not. */
export function parseDomainIds(userId: number, csv: string | undefined): number[] | undefined {
  const ids = [...new Set((csv ?? "").split(",").filter(Boolean).map(Number))];
  const live = new Set(listCategories("domains", userId).map((d) => d.id));
  return ids.every((id) => live.has(id)) ? ids : undefined;
}

/** "Infra, SRE" from the "add a new domain" box. */
export const splitNames = (s: string | undefined) =>
  [...new Set((s ?? "").split(",").map((x) => x.trim()).filter(Boolean))];

const AUTO_COLOURS = ["teal", "purple", "orange", "pink", "green", "yellow", "magenta", "turquoise", "blue", "red", "grey"];

/** Ids for these names, creating any that do not exist yet. */
export function ensureDomains(userId: number, names: string[]): number[] {
  const live = listCategories("domains", userId);
  return names.map((name) => {
    const found = live.find((d) => d.name.toLowerCase() === name.toLowerCase());
    if (found) return found.id;
    const id = addCategory("domains", userId, name, nextColour("domains", userId), false);
    live.push({ id, name, colour: "", sort_order: 0, is_closed: 0, archived_at: null });
    return id;
  });
}

export function setDomains(kind: "task" | "link", id: number, domainIds: number[]): void {
  const [table, key] = kind === "task" ? ["task_domains", "task_id"] : ["link_domains", "link_id"];
  const d = db();
  d.prepare(`DELETE FROM ${table} WHERE ${key} = ?`).run(id);
  const insert = d.prepare(`INSERT OR IGNORE INTO ${table} (${key}, domain_id) VALUES (?, ?)`);
  for (const domainId of domainIds) insert.run(id, domainId);
}

export function setArchived(kind: Kind, userId: number, id: number, archived: boolean): void {
  db()
    .prepare(`UPDATE ${kind} SET archived_at = ? WHERE id = ? AND user_id = ?`)
    .run(archived ? now() : null, id, userId);
}

/** Reads the DomainPicker fields of a form. New names are created only by `ensureDomains`, after validation. */
export function readDomainFields(
  userId: number,
  f: Record<string, string>,
): { ids: number[]; newNames: string[]; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const ids = parseDomainIds(userId, f.domain_ids);
  if (!ids) errors.domain_ids = "Select domains from the list";
  const newNames = splitNames(f.new_domains);
  if (newNames.some((n) => n.length > 40)) errors.new_domains = "Each new domain must be 40 characters or fewer";
  return { ids: ids ?? [], newNames, errors };
}
