import fs from "node:fs";
import path from "node:path";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { sessionUser } from "./auth.ts";
import { HOST, ROOT, isLoopback } from "./config.ts";
import { accountRoutes, authRoutes, SESSION_COOKIE } from "./routes/account.tsx";
import { helperRoutes } from "./routes/helper.ts";
import { journalRoutes } from "./routes/journal.tsx";
import { linkRoutes } from "./routes/links.tsx";
import { placeRoutes } from "./routes/places.tsx";
import { settingsRoutes } from "./routes/settings.tsx";
import { taskRoutes } from "./routes/tasks.tsx";
import { todayRoutes } from "./routes/today.tsx";
import { type Env, page } from "./web.tsx";

const TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
};

const GOVUK_CSS = path.join(ROOT, "node_modules/govuk-frontend/dist/govuk/govuk-frontend.min.css");

function sendFile(file: string): Response {
  const body = fs.readFileSync(file);
  return new Response(body, {
    headers: {
      "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    },
  });
}

export function createApp(opts: { host?: string } = {}) {
  const app = new Hono<Env>();
  const checkHost = isLoopback(opts.host ?? HOST);

  app.use("*", async (c, next) => {
    let ip = "";
    try {
      ip = getConnInfo(c).remote.address ?? "";
    } catch {
      // app.request() in tests has no socket
    }
    c.set("ip", ip);

    const host = c.req.header("host") ?? "";
    // Bound to loopback: refuse any other Host, which blocks DNS rebinding.
    if (checkHost && !isLoopback(host.replace(/:\d+$/, "").replace(/^\[|\]$/g, ""))) {
      return c.text("Forbidden host", 403);
    }
    if (!["GET", "HEAD"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      const site = c.req.header("sec-fetch-site");
      if (origin ? origin !== `http://${host}` : site && site !== "same-origin" && site !== "none") {
        return c.text("Cross-origin request refused", 403);
      }
    }

    await next();
    c.header("X-Frame-Options", "DENY");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    if (!c.res.headers.get("Cache-Control")) c.header("Cache-Control", "no-store");
  });

  app.get("/assets/govuk-frontend.min.css", () => sendFile(GOVUK_CSS));
  // GDS Transport is licensed for government use only; ledger.css maps the
  // family to local Arial, so the font files are never served.
  app.get("/assets/*", (c) => c.notFound());
  app.get("/static/*", (c) => {
    const rel = path.normalize(c.req.path.slice("/static/".length));
    const file = path.join(ROOT, "static", rel);
    if (rel.startsWith("..") || !fs.existsSync(file) || !fs.statSync(file).isFile()) return c.notFound();
    return sendFile(file);
  });

  app.route("/", authRoutes);
  app.route("/api/helper", helperRoutes);

  app.use("*", async (c, next) => {
    const user = sessionUser(getCookie(c, SESSION_COOKIE));
    if (!user) {
      if (c.req.method !== "GET") return c.text("Signed out", 401);
      const url = new URL(c.req.url);
      return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
    }
    c.set("user", user);
    await next();
  });

  app.route("/", todayRoutes);
  app.route("/", accountRoutes);
  app.route("/journal", journalRoutes);
  app.route("/tasks", taskRoutes);
  app.route("/links", linkRoutes);
  app.route("/places", placeRoutes);
  app.route("/settings", settingsRoutes);

  app.notFound((c) => {
    c.status(404);
    return page(
      c,
      { title: "Page not found" },
      <>
        <h1 class="govuk-heading-l">Page not found</h1>
        <p class="govuk-body">If you typed the web address, check it is correct.</p>
        <p class="govuk-body">
          <a class="govuk-link" href="/">
            Go to Today
          </a>
        </p>
      </>,
    );
  });

  app.onError((err, c) => {
    console.error(err);
    c.status(500);
    return page(
      c,
      { title: "Sorry, there is a problem with the service" },
      <>
        <h1 class="govuk-heading-l">Sorry, there is a problem with the service</h1>
        <p class="govuk-body">Try again later. The error has been written to the server log.</p>
      </>,
    );
  });

  return app;
}
