import { type DomainRef, domainsJson, parseDomains, setDomains } from "./categories.ts";
import { db, likeArg, localDate, now } from "./db.ts";

export interface Task {
  id: number;
  title: string;
  description: string;
  timeline: string;
  status_id: number;
  board_position: number;
  assigned_at: string | null;
  due_by: string | null;
  created_at: string;
  updated_at: string;
  status_name: string;
  status_colour: string;
  is_closed: number;
  domains: DomainRef[];
}

type Row = Omit<Task, "domains"> & { domains_json: string };
const toTask = ({ domains_json, ...t }: Row): Task => ({ ...t, domains: parseDomains(domains_json) });

const SELECT = `
  SELECT t.id, t.title, t.description, t.timeline, t.status_id, t.board_position,
         t.assigned_at, t.due_by, t.created_at, t.updated_at,
         s.name AS status_name, s.colour AS status_colour, s.is_closed,
         ${domainsJson("task_domains", "task_id", "t.id")} AS domains_json
  FROM tasks t
  JOIN statuses s ON s.id = t.status_id
  WHERE t.user_id = ? AND t.deleted_at IS NULL`;

export interface TaskFilter {
  /** A status id, or "open" / "closed" / "all". */
  status?: string;
  domain?: string;
  due?: "overdue" | "week" | "none" | "";
  q?: string;
  sort?: "due" | "created" | "updated" | "title" | "status";
}

const ORDER: Record<NonNullable<TaskFilter["sort"]>, string> = {
  due: "t.due_by IS NULL, t.due_by, t.created_at DESC",
  created: "t.created_at DESC",
  updated: "t.updated_at DESC",
  title: "t.title COLLATE NOCASE",
  status: "s.sort_order, t.board_position, t.id",
};

export function listTasks(userId: number, f: TaskFilter = {}): Task[] {
  const where: string[] = [];
  const args: unknown[] = [userId];
  const status = f.status || "open";
  if (status === "open") where.push("s.is_closed = 0");
  else if (status === "closed") where.push("s.is_closed = 1");
  else if (status !== "all") {
    where.push("t.status_id = ?");
    args.push(Number(status));
  }
  if (f.domain === "none") where.push("NOT EXISTS (SELECT 1 FROM task_domains x WHERE x.task_id = t.id)");
  else if (f.domain) {
    where.push("EXISTS (SELECT 1 FROM task_domains x WHERE x.task_id = t.id AND x.domain_id = ?)");
    args.push(Number(f.domain));
  }
  const today = localDate();
  if (f.due === "overdue") {
    where.push("t.due_by < ? AND s.is_closed = 0");
    args.push(today);
  } else if (f.due === "week") {
    const week = localDate(new Date(Date.now() + 7 * 86_400_000));
    where.push("t.due_by <= ?");
    args.push(week);
  } else if (f.due === "none") where.push("t.due_by IS NULL");
  if (f.q) {
    where.push("(t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\' OR t.timeline LIKE ? ESCAPE '\\')");
    const like = likeArg(f.q);
    args.push(like, like, like);
  }
  const sql = `${SELECT} ${where.map((w) => `AND ${w}`).join(" ")}
               ORDER BY ${ORDER[f.sort ?? "due"] ?? ORDER.due}`;
  return (db().prepare(sql).all(...args) as Row[]).map(toTask);
}

export function getTask(userId: number, id: number): Task | undefined {
  const row = db().prepare(`${SELECT} AND t.id = ?`).get(userId, id) as Row | undefined;
  return row && toTask(row);
}

export interface TaskInput {
  title: string;
  description: string;
  domain_ids: number[];
  timeline: string;
  status_id: number;
  assigned_at: string | null;
  due_by: string | null;
}

function endOfColumn(userId: number, statusId: number): number {
  const { pos } = db()
    .prepare("SELECT COALESCE(MAX(board_position), 0) + 1 AS pos FROM tasks WHERE user_id = ? AND status_id = ?")
    .get(userId, statusId) as { pos: number };
  return pos;
}

export function createTask(userId: number, t: TaskInput): number {
  const d = db();
  return d.transaction(() => {
    const at = now();
    const { lastInsertRowid } = d
      .prepare(
        `INSERT INTO tasks (user_id, title, description, timeline, status_id, board_position,
                            assigned_at, due_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(userId, t.title, t.description, t.timeline, t.status_id, endOfColumn(userId, t.status_id), t.assigned_at, t.due_by, at, at);
    const id = Number(lastInsertRowid);
    setDomains("task", id, t.domain_ids);
    d.prepare("INSERT INTO task_events (task_id, from_status_id, to_status_id, at) VALUES (?, NULL, ?, ?)").run(id, t.status_id, at);
    return id;
  })();
}

export function updateTask(userId: number, id: number, t: TaskInput): void {
  const d = db();
  d.transaction(() => {
    const before = getTask(userId, id);
    if (!before) return;
    d.prepare(
      `UPDATE tasks SET title = ?, description = ?, timeline = ?, assigned_at = ?, due_by = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    ).run(t.title, t.description, t.timeline, t.assigned_at, t.due_by, now(), id, userId);
    setDomains("task", id, t.domain_ids);
    if (before.status_id !== t.status_id) setStatus(userId, id, t.status_id);
  })();
}

/**
 * Moves a task to a status, recording the change. `order` is the full id order
 * of the destination column after the move (from the board); without it the
 * task goes to the bottom.
 */
export function setStatus(userId: number, id: number, statusId: number, order?: number[]): boolean {
  const d = db();
  return d.transaction(() => {
    const task = getTask(userId, id);
    const status = d
      .prepare("SELECT id FROM statuses WHERE id = ? AND user_id = ? AND archived_at IS NULL")
      .get(statusId, userId);
    if (!task || !status) return false;
    const at = now();
    if (task.status_id !== statusId) {
      d.prepare("UPDATE tasks SET status_id = ?, board_position = ?, updated_at = ? WHERE id = ?").run(
        statusId,
        endOfColumn(userId, statusId),
        at,
        id,
      );
      d.prepare("INSERT INTO task_events (task_id, from_status_id, to_status_id, at) VALUES (?, ?, ?, ?)").run(
        id,
        task.status_id,
        statusId,
        at,
      );
    }
    if (order?.length) {
      const set = d.prepare("UPDATE tasks SET board_position = ? WHERE id = ? AND user_id = ? AND status_id = ?");
      order.forEach((tid, i) => set.run(i, tid, userId, statusId));
    }
    return true;
  })();
}

export function deleteTask(userId: number, id: number): void {
  db().prepare("UPDATE tasks SET deleted_at = ? WHERE id = ? AND user_id = ?").run(now(), id, userId);
}

export interface TaskEvent {
  at: string;
  from_name: string | null;
  from_colour: string | null;
  to_name: string;
  to_colour: string;
  task_id: number;
  title: string;
}

const EVENTS = `
  SELECT e.at, e.task_id, t.title,
         f.name AS from_name, f.colour AS from_colour, s.name AS to_name, s.colour AS to_colour
  FROM task_events e
  JOIN tasks t ON t.id = e.task_id
  JOIN statuses s ON s.id = e.to_status_id
  LEFT JOIN statuses f ON f.id = e.from_status_id
  WHERE t.user_id = ?`;

export function taskHistory(userId: number, taskId: number): TaskEvent[] {
  return db().prepare(`${EVENTS} AND e.task_id = ? ORDER BY e.at DESC, e.id DESC`).all(userId, taskId) as TaskEvent[];
}

export function eventsBetween(userId: number, from: string, to: string): TaskEvent[] {
  return db()
    .prepare(`${EVENTS} AND t.deleted_at IS NULL AND e.at >= ? AND e.at < ? ORDER BY e.at`)
    .all(userId, from, to) as TaskEvent[];
}
