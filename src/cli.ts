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
import { DATA_DIR, DB_PATH, HOST, isLoopback, PORT, ROOT } from "./config.ts";
import { db } from "./db.ts";
import { helperToken, startStaleCheck, TOKEN_PATH } from "./location/geofence.ts";
import { agentPlist } from "./launchd.ts";
import { createApp } from "./server.tsx";

const LABEL = "dev.ledger.server";
const LOG = path.join(os.homedir(), "Library", "Logs", "ledger.log");

const USAGE = `Usage: ledger <command>

  serve                    Run the web app
  adduser <name>           Create an account (asks for a password)
  passwd <name>            Set a new password and sign that account out everywhere
  deluser <name>           Delete an account and everything in it
  users                    List accounts
  revoke [name]            Sign out every session, or one account's
  unlock                   Clear sign-in lockouts after too many failed attempts
  install-launchd          Start Ledger at login and keep it running
  uninstall-launchd        Stop doing that
  install-helper           Build and start Ledger Locator, which logs visits to your places
  uninstall-helper         Remove it

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

const agentPath = (label: string) => path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);

/** Writes a LaunchAgent and (re)starts it. */
function loadAgent(label: string, plist: string): void {
  const file = agentPath(label);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.writeFileSync(file, plist);
  unloadAgent(label);
  execFileSync("launchctl", ["bootstrap", `gui/${process.getuid!()}`, file], { stdio: "inherit" });
}

function unloadAgent(label: string): void {
  try {
    execFileSync("launchctl", ["bootout", `gui/${process.getuid!()}/${label}`], { stdio: "ignore" });
  } catch {
    // not loaded
  }
}

function installLaunchd(): void {
  const env: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const k of ["LEDGER_PORT", "LEDGER_HOST", "LEDGER_DB", "LEDGER_DATA"]) if (process.env[k]) env[k] = process.env[k]!;
  const args = [process.execPath, "--import", path.join(ROOT, "node_modules/tsx/dist/loader.mjs"), path.join(ROOT, "src/cli.ts"), "serve"];
  loadAgent(LABEL, agentPlist(LABEL, args, LOG, env, ROOT));
  console.log(`Installed ${agentPath(LABEL)}\nLedger will run at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT} from now on.\nLog: ${LOG}`);
}

function uninstallLaunchd(): void {
  unloadAgent(LABEL);
  fs.rmSync(agentPath(LABEL), { force: true });
  console.log("Ledger will no longer start at login.");
}

// ---------------------------------------------------------------- location helper

const HELPER_LABEL = "dev.ledger.locator";
const HELPER_APP = path.join(DATA_DIR, "Ledger Locator.app");
const HELPER_LOG = path.join(os.homedir(), "Library", "Logs", "ledger-locator.log");

function installHelper(): void {
  const macos = path.join(HELPER_APP, "Contents", "MacOS");
  const binary = path.join(macos, "LedgerLocator");
  fs.rmSync(HELPER_APP, { recursive: true, force: true });
  fs.mkdirSync(macos, { recursive: true });
  console.log("Building Ledger Locator (takes a moment)...");
  try {
    execFileSync("xcrun", ["swiftc", "-O", "-o", binary, path.join(ROOT, "helper", "LedgerLocator.swift")], { stdio: "inherit" });
  } catch {
    die("could not build the helper. It needs the Xcode command line tools: xcode-select --install");
  }
  fs.copyFileSync(path.join(ROOT, "helper", "Info.plist"), path.join(HELPER_APP, "Contents", "Info.plist"));
  // Ad hoc signature: enough for this Mac. macOS ties the location permission
  // to it, so a rebuild may ask for permission again.
  execFileSync("codesign", ["--force", "--sign", "-", "--identifier", HELPER_LABEL, HELPER_APP], { stdio: "inherit" });

  helperToken(); // make sure the shared secret exists before the helper reads it
  const url = `http://${isLoopback(HOST) || HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`;
  loadAgent(HELPER_LABEL, agentPlist(HELPER_LABEL, [binary, "--url", url, "--token-file", TOKEN_PATH], HELPER_LOG, {}));
  console.log(`Installed ${HELPER_APP}
It starts at login and reports to ${url}.
macOS will ask whether Ledger Locator may use your location: choose Allow.
If it does not ask, open System Settings, Privacy and Security, Location Services.
Log: ${HELPER_LOG}`);
}

function uninstallHelper(): void {
  unloadAgent(HELPER_LABEL);
  fs.rmSync(agentPath(HELPER_LABEL), { force: true });
  fs.rmSync(HELPER_APP, { recursive: true, force: true });
  console.log("Ledger Locator removed. Visits will no longer be logged.");
}

// ---------------------------------------------------------------- serve

function runServer(): void {
  if (!isLoopback(HOST) && !hasUsers()) {
    die(`refusing to listen on ${HOST} with no accounts. Run: ledger adduser <name>`);
  }
  db(); // migrate before taking requests
  helperToken();
  const stopStaleCheck = startStaleCheck(db());
  const server = serve({ fetch: createApp().fetch, hostname: HOST, port: PORT }, (info) => {
    const host = info.family === "IPv6" ? `[${info.address}]` : info.address;
    console.log(`Ledger on http://${host}:${info.port}`);
    if (!hasUsers()) console.log("No accounts yet. Create one with: bin/ledger adduser <name>");
  });
  const stop = () => {
    stopStaleCheck();
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

    case "install-helper":
      return installHelper();

    case "uninstall-helper":
      return uninstallHelper();

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
