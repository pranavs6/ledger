import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DATA_DIR =
  process.env.LEDGER_DATA ?? path.join(os.homedir(), "Library", "Application Support", "ledger");
export const DB_PATH = process.env.LEDGER_DB ?? path.join(DATA_DIR, "ledger.db");

export const HOST = process.env.LEDGER_HOST ?? "127.0.0.1";
export const PORT = Number(process.env.LEDGER_PORT ?? 4545);

export const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
export const isLoopback = (host: string) => LOOPBACK.has(host);
