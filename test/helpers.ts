import { createUser } from "../src/auth.ts";
import { type DB, openDb, setDb } from "../src/db.ts";

/** A fresh in-memory database installed as the shared one. */
export function freshDb(): DB {
  const d = openDb(":memory:");
  setDb(d);
  return d;
}

export async function withUser(name = "pranav", password = "correct horse"): Promise<{ db: DB; userId: number }> {
  const db = freshDb();
  const userId = await createUser(name, password);
  return { db, userId };
}
