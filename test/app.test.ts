import { beforeEach, describe, expect, it } from "vitest";
import { createSession } from "../src/auth.ts";
import { db, localDate } from "../src/db.ts";
import { network } from "../src/routes/places.tsx";
import { createApp } from "../src/server.tsx";
import { withUser } from "./helpers.ts";

const app = createApp({ host: "127.0.0.1" });
const BASE = "http://localhost:4545";
let cookie = "";
let userId = 0;

network.read = async () => ({ gatewayMac: "02:00:00:00:00:01", ssid: "Office-5G", iface: "en0" });

function req(path: string, init: RequestInit & { form?: Record<string, string>; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", "localhost:4545");
  if (cookie) headers.set("cookie", cookie);
  let body = init.body;
  if (init.form) {
    headers.set("content-type", "application/x-www-form-urlencoded");
    headers.set("origin", BASE);
    body = new URLSearchParams(init.form).toString();
  }
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    headers.set("origin", BASE);
    body = JSON.stringify(init.json);
  }
  return app.request(`${BASE}${path}`, { ...init, headers, body, method: init.method ?? (body ? "POST" : "GET") });
}

const statusId = (name: string) =>
  (db().prepare("SELECT id FROM statuses WHERE user_id = ? AND name = ?").get(userId, name) as { id: number }).id;

beforeEach(async () => {
  ({ userId } = await withUser());
  cookie = `ledger_session=${createSession(userId).token}`;
});

describe("security", () => {
  it("redirects to sign in without a session", async () => {
    cookie = "";
    const res = await req("/tasks/board");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?next=%2Ftasks%2Fboard");
  });

  it("refuses a foreign Host header (DNS rebinding)", async () => {
    const res = await app.request(`${BASE}/login`, { headers: { host: "evil.example" } });
    expect(res.status).toBe(403);
  });

  it("refuses cross-origin POSTs", async () => {
    const res = await req("/journal", {
      method: "POST",
      headers: { origin: "http://evil.example", "content-type": "application/x-www-form-urlencoded" },
      body: "title=x&entry_date=2026-09-27",
    });
    expect(res.status).toBe(403);
  });

  it("signs in with the right password only", async () => {
    cookie = "";
    const bad = await req("/login", { form: { username: "pranav", password: "wrong", next: "/" } });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("Enter a correct username and password");
    const good = await req("/login", { form: { username: "pranav", password: "correct horse", next: "/tasks" } });
    expect(good.status).toBe(302);
    expect(good.headers.get("location")).toBe("/tasks");
    expect(good.headers.get("set-cookie")).toMatch(/ledger_session=.+HttpOnly/);
  });

  it("never serves the GDS Transport font files", async () => {
    const res = await req("/assets/fonts/bold-b542beb274-v2.woff2");
    expect(res.status).toBe(404);
    expect((await req("/assets/govuk-frontend.min.css")).status).toBe(200);
  });
});

describe("pages", () => {
  it("renders every top-level page", async () => {
    for (const path of ["/", "/journal", "/tasks", "/tasks/board", "/tasks/new", "/links", "/places", "/places/log", "/settings/statuses", "/settings/domains", "/profile", "/activity"]) {
      const res = await req(path);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain('class="govuk-template"');
    }
  });

  it("shows GDS validation errors", async () => {
    const res = await req("/tasks", { form: { title: "", status_id: "" } });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("There is a problem");
    expect(html).toContain("Enter a title");
    expect(html).toContain("<title>Error: Add a task - Ledger</title>");
  });
});

describe("tasks", () => {
  it("creates, moves on the board, and records history on the day view", async () => {
    const created = await req("/tasks", {
      form: { title: "Fix payout bug", description: "**urgent**", status_id: String(statusId("Yet to begin")), timeline: "Sprint 42", due_by: "2026-10-01" },
    });
    expect(created.status).toBe(302);
    const id = Number(created.headers.get("location")!.split("/").pop());

    const moved = await req(`/tasks/${id}/status`, { json: { status_id: statusId("In review"), order: [id] } });
    expect(await moved.json()).toEqual({ ok: true });

    const detail = await (await req(`/tasks/${id}`)).text();
    expect(detail).toContain("<strong>urgent</strong>");
    expect(detail).toContain("Sprint 42");
    expect(detail).toMatch(/Yet to begin.*→.*In review/s);

    const day = await (await req(`/journal/day/${localDate()}`)).text();
    expect(day).toContain("Fix payout bug");
    expect(day).toContain("Moved to");

    const board = await (await req("/tasks/board")).text();
    expect(board).toContain(`data-id="${id}"`);
  });

  it("moves without JS through the form", async () => {
    const created = await req("/tasks", { form: { title: "Plain form", status_id: String(statusId("Yet to begin")) } });
    const id = Number(created.headers.get("location")!.split("/").pop());
    const res = await req(`/tasks/${id}/status`, { form: { status_id: String(statusId("Done")), back: "/tasks/board" } });
    expect(res.headers.get("location")).toBe("/tasks/board");
    const row = db().prepare("SELECT status_id FROM tasks WHERE id = ?").get(id) as { status_id: number };
    expect(row.status_id).toBe(statusId("Done"));
  });

  it("strips script from Markdown", async () => {
    const created = await req("/tasks", { form: { title: "x", description: "<script>alert(1)</script><img src=x onerror=alert(1)>", status_id: String(statusId("Yet to begin")) } });
    const html = await (await req(created.headers.get("location")!)).text();
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("onerror");
  });

  it("adds a custom status that shows up as a board column", async () => {
    await req("/settings/statuses", { form: { name: "Blocked", colour: "red" } });
    const board = await (await req("/tasks/board")).text();
    expect(board).toContain("Blocked");
  });

  it("will not archive a status that still has tasks", async () => {
    await req("/tasks", { form: { title: "Busy", status_id: String(statusId("In progress")) } });
    const res = await req(`/settings/statuses/${statusId("In progress")}/archive`, { method: "POST", headers: { origin: BASE } });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Move the 1 task in In progress");
  });
});

describe("domains and popups", () => {
  const domainId = (name: string) =>
    (db().prepare("SELECT id FROM domains WHERE user_id = ? AND name = ?").get(userId, name) as { id: number } | undefined)?.id;

  it("gives a task several domains and creates new ones inline", async () => {
    const body = new URLSearchParams({ title: "Multi", status_id: String(statusId("Yet to begin")), new_domains: "Infra, SRE" });
    body.append("domain_ids", String(domainId("UI")));
    body.append("domain_ids", String(domainId("Analytics")));
    const res = await req("/tasks", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
      body: body.toString(),
    });
    expect(res.status).toBe(302);
    const id = Number(res.headers.get("location")!.split("/").pop());
    const names = db()
      .prepare("SELECT d.name FROM task_domains x JOIN domains d ON d.id = x.domain_id WHERE x.task_id = ? ORDER BY d.sort_order")
      .all(id)
      .map((r: any) => r.name);
    expect(names).toEqual(["UI", "Analytics", "Infra", "SRE"]);

    const filtered = await (await req(`/tasks?domain=${domainId("SRE")}`)).text();
    expect(filtered).toContain("Multi");
    const other = await (await req(`/tasks?domain=${domainId("App")}`)).text();
    expect(other).not.toContain("Multi");
  });

  it("does not create new domains when the form has errors", async () => {
    const res = await req("/tasks", { form: { title: "", status_id: String(statusId("Yet to begin")), new_domains: "Ghost" } });
    expect(res.status).toBe(400);
    expect(domainId("Ghost")).toBeUndefined();
    expect(await res.text()).toContain('value="Ghost"');
  });

  it("renders only the content for the popup", async () => {
    const res = await req("/tasks/new", { headers: { "x-ledger-partial": "1" } });
    const html = await res.text();
    expect(html.startsWith('<div class="lg-partial" data-title="Add a task">')).toBe(true);
    expect(html).not.toContain("<html");
  });

  it("adds a board column with just a name", async () => {
    const res = await req("/settings/statuses", { form: { name: "Blocked", back: "/tasks/board" } });
    expect(res.headers.get("location")).toBe("/tasks/board");
    const row = db().prepare("SELECT colour FROM statuses WHERE user_id = ? AND name = 'Blocked'").get(userId) as { colour: string };
    expect(row.colour).toBeTruthy();
  });

  it("keeps settings out of the menu", async () => {
    const html = await (await req("/")).text();
    expect(html).not.toContain('href="/settings/statuses"');
    expect(await (await req("/tasks/board")).text()).toContain('href="/settings/statuses" data-modal');
  });
});

describe("places", () => {
  it("adds a place with the current network and logs a visit", async () => {
    const res = await req("/places", { form: { name: "Office", add_network: "1" } });
    expect(res.status).toBe(302);
    const placeId = Number(res.headers.get("location")!.split("/").pop());
    const nets = db().prepare("SELECT gateway_mac, ssid FROM place_networks WHERE place_id = ?").all(placeId);
    expect(nets).toEqual([{ gateway_mac: "02:00:00:00:00:01", ssid: "Office-5G" }]);

    const list = await (await req("/places")).text();
    expect(list).toContain("This Mac is at <strong>Office</strong>");

    await req(`/places/${placeId}/logging`, { form: { on: "0" } });
    const p = db().prepare("SELECT logging_enabled FROM places WHERE id = ?").get(placeId) as { logging_enabled: number };
    expect(p.logging_enabled).toBe(0);
  });
});
