// The Ledger Locator helper's API. Authenticated by the shared token in
// helper-token, not by a browser session.
import { Hono } from "hono";
import { db } from "../db.ts";
import { type AuthStatus, applyReport, type Report, tokenMatches, watchedPlaces } from "../location/geofence.ts";
import type { Env } from "../web.tsx";

export const helperRoutes = new Hono<Env>();

const AUTH: AuthStatus[] = ["authorized", "denied", "restricted", "notDetermined", "disabled"];

helperRoutes.use("*", async (c, next) => {
  const given = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!tokenMatches(given)) return c.json({ error: "bad token" }, 401);
  await next();
});

helperRoutes.get("/places", (c) => c.json({ places: watchedPlaces(db()) }));

helperRoutes.post("/report", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return c.json({ error: "expected a JSON object" }, 400);

  const report: Report = {};
  if (typeof body.auth === "string" && AUTH.includes(body.auth as AuthStatus)) report.auth = body.auth as AuthStatus;
  const loc = body.location as Record<string, unknown> | undefined;
  if (loc && typeof loc.lat === "number" && typeof loc.lon === "number") {
    report.location = {
      lat: loc.lat,
      lon: loc.lon,
      accuracy: typeof loc.accuracy === "number" ? loc.accuracy : Number.NaN,
      at: typeof loc.at === "string" ? loc.at : "",
    };
  }
  if (Array.isArray(body.states)) {
    report.states = body.states.slice(0, 200).flatMap((s: Record<string, unknown>) =>
      s && typeof s.place_id === "number" && typeof s.inside === "boolean"
        ? [{ place_id: s.place_id, inside: s.inside, at: typeof s.at === "string" ? s.at : "" }]
        : [],
    );
  }
  applyReport(db(), report);
  return c.json({ places: watchedPlaces(db()) });
});
