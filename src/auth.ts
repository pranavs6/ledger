// Users, sessions, lockout and audit: a port of loci's server/auth.py.
//
// Session tokens are opaque and live in an HttpOnly cookie; only their SHA-256
// is stored, so a leaked database cannot be replayed as a login. Passwords go
// through scrypt with a per-user salt.
import crypto from "node:crypto";
import { promisify } from "node:util";
import { db, now } from "./db.ts";

const scrypt = promisify(crypto.scrypt) as (
  pw: string,
  salt: Buffer,
  len: number,
  opts: crypto.ScryptOptions,
) => Promise<Buffer>;

export const SESSION_DAYS = 30;
export const MAX_FAILURES = 10;
export const LOCKOUT_MINUTES = 15;
export const MIN_PASSWORD = 8;

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

export interface User {
  id: number;
  username: string;
  theme: Theme;
  created_at: string;
}
export type Theme = "system" | "light" | "dark";

export const DEFAULT_STATUSES: [name: string, colour: string, closed: boolean][] = [
  ["Yet to begin", "grey", false],
  ["In progress", "blue", false],
  ["In review", "purple", false],
  ["In UAT", "orange", false],
  ["Done", "green", true],
  ["Dropped", "red", true],
];
export const DEFAULT_DOMAINS: [name: string, colour: string][] = [
  ["UI", "teal"],
  ["App", "blue"],
  ["Analytics", "purple"],
  ["Systems", "orange"],
  ["Debugging", "red"],
];

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function checkPassword(stored: string, password: string): Promise<boolean> {
  const [algo, n, r, p, salt, key] = stored.split("$");
  if (algo !== "scrypt" || !key) return false;
  const expected = Buffer.from(key, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return crypto.timingSafeEqual(expected, actual);
}

// Hashed once, used to burn the same time when a username does not exist.
let decoy: Promise<string> | undefined;

export function validatePassword(password: string): string | undefined {
  if (password.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters`;
}

export function validUsername(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,31}$/i.test(name);
}

export async function createUser(username: string, password: string): Promise<number> {
  if (!validUsername(username)) throw new Error("Username must be 1 to 32 letters, digits, '.', '_' or '-'");
  const problem = validatePassword(password);
  if (problem) throw new Error(problem);
  const pwHash = await hashPassword(password);
  const d = db();
  return d.transaction(() => {
    const { lastInsertRowid } = d
      .prepare("INSERT INTO users (username, pw_hash, created_at) VALUES (?, ?, ?)")
      .run(username, pwHash, now());
    const id = Number(lastInsertRowid);
    const st = d.prepare(
      "INSERT INTO statuses (user_id, name, colour, sort_order, is_closed) VALUES (?, ?, ?, ?, ?)",
    );
    DEFAULT_STATUSES.forEach(([name, colour, closed], i) => st.run(id, name, colour, i, closed ? 1 : 0));
    const dm = d.prepare("INSERT INTO domains (user_id, name, colour, sort_order) VALUES (?, ?, ?, ?)");
    DEFAULT_DOMAINS.forEach(([name, colour], i) => dm.run(id, name, colour, i));
    return id;
  })();
}

export async function setPassword(userId: number, password: string): Promise<void> {
  const problem = validatePassword(password);
  if (problem) throw new Error(problem);
  db().prepare("UPDATE users SET pw_hash = ? WHERE id = ?").run(await hashPassword(password), userId);
}

export function findUser(username: string): User | undefined {
  return db()
    .prepare("SELECT id, username, theme, created_at FROM users WHERE username = ?")
    .get(username) as User | undefined;
}

export function listUsers(): (User & { sessions: number })[] {
  return db()
    .prepare(
      `SELECT u.id, u.username, u.theme, u.created_at,
              (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS sessions
       FROM users u ORDER BY u.username`,
    )
    .all(now()) as (User & { sessions: number })[];
}

export function hasUsers(): boolean {
  return db().prepare("SELECT 1 FROM users LIMIT 1").get() !== undefined;
}

export function deleteUser(username: string): boolean {
  return db().prepare("DELETE FROM users WHERE username = ?").run(username).changes > 0;
}

export function setTheme(userId: number, theme: Theme): void {
  db().prepare("UPDATE users SET theme = ? WHERE id = ?").run(theme, userId);
}

// ---------------------------------------------------------------- lockout

export function lockedOut(ip: string): boolean {
  const cutoff = new Date(Date.now() - LOCKOUT_MINUTES * 60_000).toISOString();
  const d = db();
  d.prepare("DELETE FROM login_failures WHERE at < ?").run(cutoff);
  const { n } = d
    .prepare("SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND at >= ?")
    .get(ip, cutoff) as { n: number };
  return n >= MAX_FAILURES;
}

/** Clears every lockout. Returns how many failed attempts were forgotten. */
export function clearLockouts(): number {
  return db().prepare("DELETE FROM login_failures").run().changes;
}

/** Returns the user id on success. Records a failure against the IP otherwise. */
export async function verifyLogin(username: string, password: string, ip: string): Promise<number | undefined> {
  const row = db().prepare("SELECT id, pw_hash FROM users WHERE username = ?").get(username) as
    | { id: number; pw_hash: string }
    | undefined;
  // Hash even when the user is unknown, so timing does not leak existence.
  const stored = row?.pw_hash ?? (await (decoy ??= hashPassword("_no_such_user_")));
  const ok = await checkPassword(stored, password);
  if (row && ok) {
    db().prepare("DELETE FROM login_failures WHERE ip = ?").run(ip);
    return row.id;
  }
  db().prepare("INSERT INTO login_failures (ip, at) VALUES (?, ?)").run(ip, now());
}

// ---------------------------------------------------------------- sessions

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function createSession(userId: number, userAgent = ""): { token: string; expires: Date } {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  db()
    .prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)")
    .run(sha256(token), userId, now(), expires.toISOString(), userAgent.slice(0, 300));
  return { token, expires };
}

export function sessionUser(token: string | undefined): (User & { tokenHash: string }) | undefined {
  if (!token) return;
  const hash = sha256(token);
  const row = db()
    .prepare(
      `SELECT u.id, u.username, u.theme, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(hash, now()) as User | undefined;
  return row && { ...row, tokenHash: hash };
}

export function endSession(token: string): void {
  db().prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

export interface SessionRow {
  token_hash: string;
  created_at: string;
  expires_at: string;
  user_agent: string | null;
}

export function userSessions(userId: number): SessionRow[] {
  return db()
    .prepare(
      "SELECT token_hash, created_at, expires_at, user_agent FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC",
    )
    .all(userId, now()) as SessionRow[];
}

export function endOtherSessions(userId: number, keepHash: string): number {
  return db().prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(userId, keepHash).changes;
}

/** Ends every session, or every session of one user. Returns how many ended. */
export function revokeSessions(username?: string): number {
  if (!username) return db().prepare("DELETE FROM sessions").run().changes;
  return db()
    .prepare("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)")
    .run(username).changes;
}

// ---------------------------------------------------------------- audit

export function audit(userId: number | null, action: string, detail = "", ip = ""): void {
  db()
    .prepare("INSERT INTO audit (user_id, action, detail, ip, at) VALUES (?, ?, ?, ?, ?)")
    .run(userId, action, detail, ip, now());
}

export interface AuditRow {
  action: string;
  detail: string;
  ip: string;
  at: string;
}

export function auditFor(userId: number, limit = 200): AuditRow[] {
  return db()
    .prepare("SELECT action, detail, ip, at FROM audit WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT ?")
    .all(userId, limit) as AuditRow[];
}
