import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../src/db.ts";
import { applyReport, closeIfStale, distanceM, parseCoords, STALE_MS, watchedPlaces } from "../src/location/geofence.ts";
import { createPlace, deletePlace, setLogging, updatePlace } from "../src/places.ts";
import { withUser } from "./helpers.ts";

const T0 = Date.parse("2026-09-28T09:00:00Z");
const at = (mins: number) => new Date(T0 + mins * 60_000);
const iso = (mins: number) => at(mins).toISOString();

let db: DB;
let userId: number;
let office: number;

const visits = () =>
  db.prepare("SELECT place_id, entered_at, exited_at FROM visits ORDER BY id").all() as {
    place_id: number;
    entered_at: string;
    exited_at: string | null;
  }[];

/** One heartbeat at `mins`, saying whether we are in the office (and since when). */
const beat = (mins: number, inside?: boolean, since = mins) =>
  applyReport(db, { auth: "authorized", states: inside === undefined ? [] : [{ place_id: office, inside, at: iso(since) }] }, at(mins));

beforeEach(async () => {
  ({ db, userId } = await withUser());
  office = createPlace(userId, { name: "Office", lat: 12.9716, lon: 77.5946, radius_m: 150 });
});

describe("geofence visits", () => {
  it("opens on inside and closes on outside, at the helper's times", () => {
    beat(0, true);
    expect(visits()).toEqual([{ place_id: office, entered_at: iso(0), exited_at: null }]);
    beat(1, true, 0); // re-sent state: no duplicate
    beat(2, false);
    expect(visits()).toEqual([{ place_id: office, entered_at: iso(0), exited_at: iso(2) }]);
  });

  it("closes at the last check-in when the helper goes quiet, and reopens at the next", () => {
    beat(0, true);
    beat(1, true, 0);
    beat(61, true, 0); // an hour asleep, still in the office
    expect(visits()).toEqual([
      { place_id: office, entered_at: iso(0), exited_at: iso(1) },
      { place_id: office, entered_at: iso(61), exited_at: null },
    ]);
  });

  it("closes stale visits even if the helper never comes back", () => {
    beat(0, true);
    closeIfStale(db, new Date(T0 + STALE_MS + 60_000));
    expect(visits()[0].exited_at).toBe(iso(0));
  });

  it("ignores places with logging off, and closes their visit when switched off", () => {
    beat(0, true);
    setLogging(userId, office, false);
    expect(visits()[0].exited_at).not.toBeNull();
    beat(1, true, 0);
    expect(visits()).toHaveLength(1);
    expect(watchedPlaces(db)).toEqual([]);
  });

  it("ends the visit when the geofence moves", () => {
    beat(0, true);
    updatePlace(userId, office, { name: "Office", lat: 12.98, lon: 77.6, radius_m: 150 });
    expect(visits()[0].exited_at).not.toBeNull();
  });

  it("stops watching deleted places", () => {
    deletePlace(userId, office);
    expect(watchedPlaces(db)).toEqual([]);
  });

  it("records the helper's permission and location", () => {
    applyReport(db, { auth: "denied", location: { lat: 1, lon: 2, accuracy: 40, at: iso(0) } }, at(0));
    const s = db.prepare("SELECT auth_status, lat, lon, accuracy_m FROM helper_state").get();
    expect(s).toEqual({ auth_status: "denied", lat: 1, lon: 2, accuracy_m: 40 });
  });
});

describe("geometry", () => {
  it("measures distance", () => {
    // One degree of latitude on a 6371 km sphere.
    expect(distanceM(0, 0, 1, 0)).toBeCloseTo(111_195, -1);
    expect(distanceM(12.9716, 77.5946, 12.9716, 77.5946)).toBe(0);
  });

  it("parses pasted coordinates", () => {
    expect(parseCoords("12.9716, 77.5946")).toEqual({ lat: 12.9716, lon: 77.5946 });
    expect(parseCoords("-33.86 151.21")).toEqual({ lat: -33.86, lon: 151.21 });
    expect(parseCoords("91, 0")).toBeUndefined();
    expect(parseCoords("office")).toBeUndefined();
  });
});
