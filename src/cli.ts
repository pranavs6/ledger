// bin/ledger: run the server and manage accounts.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { serve } from "@hono/node-server";
import {
  clearLockouts,
  createUser,
  deleteUser,
  findUser,
  hasUsers,
  listUsers,
  revokeSessions,
  setPassword,
  validatePassword,
} from "./auth.ts";
import { DB_PATH, HOST, isLoopback, PORT, ROOT } from "./config.ts";
import { db } from "./db.ts";
import { Detector } from "./location/detector.ts";
import { createApp } from "./server.tsx";

const LABEL = "dev.ledger.server";
const PLIST = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG = path.join(os.homedir(), "Library", "Logs", "ledger.log");

const USAGE = `Usage: ledger <command>

  serve                    Run the web app and the location detector
  adduser <name>           Create an account (asks for a password)
  passwd <name>            Set a new password and sign that account out everywhere
  deluser <name>           Delete an account and everything in it
  users                    List accounts
  revoke [name]            Sign out every session, or one account's
  unlock                   Clear sign-in lockouts after too many failed attempts
  install-launchd          Start Ledger at login and keep it running
  uninstall-launchd        Stop doing that

Environment: LEDGER_PORT (4545), LEDGER_HOST (127.0.0.1), LEDGER_DB
Database: ${DB_PATH}`;

function die(msg: string): never {
  console.error(`ledger: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------- password prompt

let pipedLines: AsyncIterator<string> | undefined;

/** Hidden input on a terminal; one line at a time when piped. */
async function ask(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    pipedLines ??= readline.createInterface({ input: stdin })[Symbol.asyncIterator]();
    const { value, done } = await pipedLines.next();
    return done ? "" : value;
  }
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let s = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(s);
        }
        if (ch === "\u0003") {
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") s = s.slice(0, -1);
        else s += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function newPassword(): Promise<string> {
  for (;;) {
    const pw = await ask("Password: ");
    const problem = validatePassword(pw);
    if (problem) {
      console.error(problem);
      if (!process.stdin.isTTY) process.exit(1);
      continue;
    }
    if ((await ask("Confirm password: ")) === pw) return pw;
    console.error("Passwords do not match");
    if (!process.stdin.isTTY) process.exit(1);
  }
}

// ---------------------------------------------------------------- launchd

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function installLaunchd(): void {
  const env: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const k of ["LEDGER_PORT", "LEDGER_HOST", "LEDGER_DB", "LEDGER_DATA"]) if (process.env[k]) env[k] = process.env[k]!;
  const plist = fs
    .readFileSync(path.join(ROOT, "launchd", `${LABEL}.plist.template`), "utf8")
    .replaceAll("{{NODE}}", xml(process.execPath))
    .replaceAll("{{ROOT}}", xml(ROOT))
    .replaceAll("{{LOG}}", xml(LOG))
    .replace(
      "{{ENV}}",
      Object.entries(env)
        .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
        .join("\n"),
    );
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.writeFileSync(PLIST, plist);
  const domain = `gui/${process.getuid!()}`;
  try {
    execFileSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });
  } catch {
    // not loaded yet
  }
  execFileSync("launchctl", ["bootstrap", domain, PLIST], { stdio: "inherit" });
  console.log(`Installed ${PLIST}\nLedger will run at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT} from now on.\nLog: ${LOG}`);
}

function uninstallLaunchd(): void {
  try {
    execFileSync("launchctl", ["bootout", `gui/${process.getuid!()}/${LABEL}`], { stdio: "ignore" });
  } catch {
    // not loaded
  }
  fs.rmSync(PLIST, { force: true });
  console.log("Ledger will no longer start at login.");
}

// ---------------------------------------------------------------- serve

function runServer(): void {
  if (!isLoopback(HOST) && !hasUsers()) {
    die(`refusing to listen on ${HOST} with no accounts. Run: ledger adduser <name>`);
  }
  db(); // migrate before taking requests
  const detector = new Detector(db());
  const server = serve({ fetch: createApp().fetch, hostname: HOST, port: PORT }, (info) => {
    const host = info.family === "IPv6" ? `[${info.address}]` : info.address;
    console.log(`Ledger on http://${host}:${info.port}`);
    if (!hasUsers()) console.log("No accounts yet. Create one with: bin/ledger adduser <name>");
  });
  detector.start();
  const stop = () => {
    detector.stop();
    server.close();
    db().close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

// ---------------------------------------------------------------- main

async function main(argv: string[]): Promise<void> {
  const [cmd, arg] = argv;
  switch (cmd) {
    case "serve":
      return runServer();

    case "adduser": {
      if (!arg) die("usage: ledger adduser <name>");
      if (findUser(arg)) die(`${arg} already exists`);
      const pw = await newPassword();
      try {
        await createUser(arg, pw);
      } catch (e) {
        die((e as Error).message);
      }
      console.log(`Created ${arg}. Sign in at http://localhost:${PORT}`);
      return;
    }

    case "passwd": {
      if (!arg) die("usage: ledger passwd <name>");
      const user = findUser(arg) ?? die(`no account called ${arg}`);
      await setPassword(user.id, await newPassword());
      const n = revokeSessions(arg);
      console.log(`Password changed for ${arg}; ${n} ${n === 1 ? "session" : "sessions"} signed out.`);
      return;
    }

    case "deluser": {
      if (!arg) die("usage: ledger deluser <name>");
      if (!findUser(arg)) die(`no account called ${arg}`);
      if (process.stdin.isTTY) {
        const typed = await new Promise<string>((resolve) => {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          rl.question(`This deletes ${arg} and all their journal entries, tasks, links and places.\nType the name to confirm: `, (a) => {
            rl.close();
            resolve(a.trim());
          });
        });
        if (typed !== arg) die("names did not match; nothing deleted");
      }
      deleteUser(arg);
      console.log(`Deleted ${arg}.`);
      return;
    }

    case "users": {
      const users = listUsers();
      if (!users.length) return console.log("No accounts. Create one with: ledger adduser <name>");
      for (const u of users) {
        console.log(`${u.username.padEnd(20)} created ${u.created_at.slice(0, 10)}   ${u.sessions} active ${u.sessions === 1 ? "session" : "sessions"}`);
      }
      return;
    }

    case "revoke": {
      if (arg && !findUser(arg)) die(`no account called ${arg}`);
      const n = revokeSessions(arg);
      console.log(`Signed out ${n} ${n === 1 ? "session" : "sessions"}.`);
      return;
    }

    case "unlock": {
      const n = clearLockouts();
      console.log(n ? `Cleared ${n} failed ${n === 1 ? "attempt" : "attempts"}. You can sign in again.` : "Nothing was locked.");
      return;
    }

    case "install-launchd":
      return installLaunchd();

    case "uninstall-launchd":
      return uninstallLaunchd();

    case undefined:
    case "help":
    case "-h":
    case "--help":
      return console.log(USAGE);

    default:
      console.error(USAGE);
      process.exit(2);
  }
}

await main(process.argv.slice(2));
// A piped-stdin reader would otherwise keep one-shot commands alive.
if (process.argv[2] !== "serve") process.exit(0);
