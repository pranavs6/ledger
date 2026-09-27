import { describe, expect, it } from "vitest";
import {
  checkPassword,
  createSession,
  createUser,
  hashPassword,
  lockedOut,
  MAX_FAILURES,
  revokeSessions,
  sessionUser,
  verifyLogin,
} from "../src/auth.ts";
import { db } from "../src/db.ts";
import { freshDb, withUser } from "./helpers.ts";

describe("passwords", () => {
  it("hashes with a salt and verifies", async () => {
    const a = await hashPassword("correct horse");
    const b = await hashPassword("correct horse");
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt$")).toBe(true);
    expect(await checkPassword(a, "correct horse")).toBe(true);
    expect(await checkPassword(a, "wrong horse")).toBe(false);
  });

  it("refuses short passwords and odd usernames", async () => {
    freshDb();
    await expect(createUser("pranav", "short")).rejects.toThrow(/at least 8/);
    await expect(createUser("no spaces", "long enough")).rejects.toThrow(/Username/);
  });

  it("seeds default statuses and domains", async () => {
    const { userId } = await withUser();
    const statuses = db().prepare("SELECT name FROM statuses WHERE user_id = ? ORDER BY sort_order").all(userId);
    expect(statuses.map((s: any) => s.name)).toEqual(["Yet to begin", "In progress", "In review", "In UAT", "Done", "Dropped"]);
    const domains = db().prepare("SELECT name FROM domains WHERE user_id = ? ORDER BY sort_order").all(userId);
    expect(domains.map((d: any) => d.name)).toEqual(["UI", "App", "Analytics", "Systems", "Debugging"]);
  });
});

describe("login", () => {
  it("verifies, and records failures for unknown users too", async () => {
    const { userId } = await withUser();
    expect(await verifyLogin("pranav", "correct horse", "1.1.1.1")).toBe(userId);
    expect(await verifyLogin("pranav", "nope", "1.1.1.1")).toBeUndefined();
    expect(await verifyLogin("ghost", "nope", "1.1.1.1")).toBeUndefined();
    const { n } = db().prepare("SELECT COUNT(*) AS n FROM login_failures").get() as { n: number };
    expect(n).toBe(2);
  });

  it("locks an IP out after too many failures, and only that IP", async () => {
    await withUser();
    for (let i = 0; i < MAX_FAILURES; i++) await verifyLogin("pranav", "nope", "6.6.6.6");
    expect(lockedOut("6.6.6.6")).toBe(true);
    expect(lockedOut("7.7.7.7")).toBe(false);
  });
});

describe("sessions", () => {
  it("stores only a hash of the token", async () => {
    const { userId } = await withUser();
    const { token } = createSession(userId, "test");
    const rows = db().prepare("SELECT token_hash FROM sessions").all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toContain(token);
    expect(sessionUser(token)?.id).toBe(userId);
    expect(sessionUser(rows[0].token_hash)).toBeUndefined();
  });

  it("revokes", async () => {
    const { userId } = await withUser();
    const { token } = createSession(userId);
    expect(revokeSessions("pranav")).toBe(1);
    expect(sessionUser(token)).toBeUndefined();
  });
});
