import { db, now, shiftDay } from "./db.ts";

export interface Goal {
  id: number;
  goal_date: string;
  title: string;
  done_at: string | null;
  carried_from: string | null;
  /** Null when there is no task or the task was deleted. */
  task_id: number | null;
  task_title: string | null;
  status_name: string | null;
  status_colour: string | null;
}

const SELECT = `
  SELECT g.id, g.goal_date, g.title, g.done_at, g.carried_from,
         t.id AS task_id, t.title AS task_title, s.name AS status_name, s.colour AS status_colour
  FROM goals g
  LEFT JOIN tasks t ON t.id = g.task_id AND t.deleted_at IS NULL
  LEFT JOIN statuses s ON s.id = t.status_id
  WHERE g.user_id = ?`;

export const goalsOn = (userId: number, date: string) =>
  db().prepare(`${SELECT} AND g.goal_date = ? ORDER BY g.id`).all(userId, date) as Goal[];

export const getGoal = (userId: number, id: number) =>
  db().prepare(`${SELECT} AND g.id = ?`).get(userId, id) as Goal | undefined;

/** Goals left unfinished in the `days` before `date`, which can be carried over to it. */
export const unfinishedBefore = (userId: number, date: string, days = 7) =>
  db()
    .prepare(`${SELECT} AND g.done_at IS NULL AND g.goal_date < ? AND g.goal_date >= ? ORDER BY g.goal_date, g.id`)
    .all(userId, date, shiftDay(date, -days)) as Goal[];

export interface GoalInput {
  goal_date: string;
  title: string;
  task_id: number | null;
}

export function addGoal(userId: number, g: GoalInput): number {
  const { lastInsertRowid } = db()
    .prepare("INSERT INTO goals (user_id, goal_date, title, task_id, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(userId, g.goal_date, g.title, g.task_id, now());
  return Number(lastInsertRowid);
}

export function updateGoal(userId: number, id: number, g: GoalInput): void {
  db()
    .prepare("UPDATE goals SET goal_date = ?, title = ?, task_id = ? WHERE id = ? AND user_id = ?")
    .run(g.goal_date, g.title, g.task_id, id, userId);
}

export function setGoalDone(userId: number, id: number, done: boolean): boolean {
  const { changes } = db()
    .prepare("UPDATE goals SET done_at = ? WHERE id = ? AND user_id = ?")
    .run(done ? now() : null, id, userId);
  return changes > 0;
}

export function deleteGoal(userId: number, id: number): void {
  db().prepare("DELETE FROM goals WHERE id = ? AND user_id = ?").run(id, userId);
}

/** Moves unfinished goals from earlier days to `to`. Returns how many moved. */
export function carryOver(userId: number, ids: number[], to: string): number {
  const move = db().prepare(
    `UPDATE goals SET carried_from = COALESCE(carried_from, goal_date), goal_date = ?
     WHERE id = ? AND user_id = ? AND done_at IS NULL AND goal_date < ?`,
  );
  return db().transaction(() => ids.reduce((n, id) => n + move.run(to, id, userId, to).changes, 0))();
}

export interface DaySummary {
  goals: number;
  done: number;
  entries: number;
  due: number;
}

/** Per-day counts of goals, journal entries and open tasks due, for from..to inclusive. */
export function daySummaries(userId: number, from: string, to: string): Map<string, DaySummary> {
  const out = new Map<string, DaySummary>();
  const day = (d: string) => {
    let s = out.get(d);
    if (!s) out.set(d, (s = { goals: 0, done: 0, entries: 0, due: 0 }));
    return s;
  };
  const d = db();
  for (const r of d
    .prepare(
      `SELECT goal_date AS date, COUNT(*) AS n, COUNT(done_at) AS done FROM goals
       WHERE user_id = ? AND goal_date BETWEEN ? AND ? GROUP BY goal_date`,
    )
    .all(userId, from, to) as { date: string; n: number; done: number }[]) {
    Object.assign(day(r.date), { goals: r.n, done: r.done });
  }
  for (const r of d
    .prepare(
      `SELECT entry_date AS date, COUNT(*) AS n FROM journal_entries
       WHERE user_id = ? AND deleted_at IS NULL AND entry_date BETWEEN ? AND ? GROUP BY entry_date`,
    )
    .all(userId, from, to) as { date: string; n: number }[]) {
    day(r.date).entries = r.n;
  }
  for (const r of d
    .prepare(
      `SELECT t.due_by AS date, COUNT(*) AS n FROM tasks t JOIN statuses s ON s.id = t.status_id
       WHERE t.user_id = ? AND t.deleted_at IS NULL AND s.is_closed = 0 AND t.due_by BETWEEN ? AND ? GROUP BY t.due_by`,
    )
    .all(userId, from, to) as { date: string; n: number }[]) {
    day(r.date).due = r.n;
  }
  return out;
}
