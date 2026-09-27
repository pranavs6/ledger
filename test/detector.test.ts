import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../src/db.ts";
import { step } from "../src/location/detector.ts";
import { addNetwork, createPlace, deletePlace, setLogging } from "../src/places.ts";
import { withUser } from "./helpers.ts";

const OFFICE = "02:00:00:00:00:01";
const HOME = "02:00:00:00:00:02";
const T0 = Date.parse("2026-09-28T09:00:00Z");
const at = (secs: number) => new Date(T0 + secs * 1000);
const iso = (secs: number) => at(secs).toISOString();

let db: DB;
let userId: number;
let office: number;
let home: number;

const visits = () =>
  db.prepare("SELECT place_id, entered_at, exited_at FROM visits ORDER BY id").all() as {
    place_id: number;
    entered_at: string;
    exited_at: string | null;
  }[];

beforeEach(async () => {
  ({ db, userId } = await withUser());
  office = createPlace(userId, "Office");
  home = createPlace(userId, "Home");
  addNetwork(office, { gatewayMac: OFFICE }, "Office Wi-Fi");
  addNetwork(home, { gatewayMac: HOME }, "Home");
});

describe("detector", () => {
  it("opens a visit once a network is seen twice, timed at the first sighting", () => {
    step(db, at(0), { gatewayMac: OFFICE });
    expect(visits()).toEqual([]);
    step(db, at(30), { gatewayMac: OFFICE });
    expect(visits()).toEqual([{ place_id: office, entered_at: iso(0), exited_at: null }]);
    step(db, at(60), { gatewayMac: OFFICE });
    expect(visits()).toHaveLength(1);
  });

  it("moves between places", () => {
    step(db, at(0), { gatewayMac: OFFICE });
    step(db, at(30), { gatewayMac: OFFICE });
    step(db, at(60), { gatewayMac: HOME });
    expect(visits()[0].exited_at).toBeNull();
    step(db, at(90), { gatewayMac: HOME });
    expect(visits()).toEqual([
      { place_id: office, entered_at: iso(0), exited_at: iso(60) },
      { place_id: home, entered_at: iso(60), exited_at: null },
    ]);
  });

  it("ignores a one-tick blip", () => {
    step(db, at(0), { gatewayMac: OFFICE });
    step(db, at(30), { gatewayMac: OFFICE });
    step(db, at(60), {});
    step(db, at(90), { gatewayMac: OFFICE });
    step(db, at(120), { gatewayMac: OFFICE });
    expect(visits()).toEqual([{ place_id: office, entered_at: iso(0), exited_at: null }]);
  });

  it("closes the visit when the network goes away", () => {
    step(db, at(0), { gatewayMac: OFFICE });
    step(db, at(30), { gatewayMac: OFFICE });
    step(db, at(60), {});
    step(db, at(90), {});
    expect(visits()).toEqual([{ place_id: office, entered_at: iso(0), exited_at: iso(60) }]);
  });

  it("closes at the last tick before a sleep, and reopens only after two ticks on waking", () => {
    step(db, at(0), { gatewayMac: OFFICE });
    step(db, at(30), { gatewayMac: OFFICE });
    step(db, at(30 + 3600), { gatewayMac: OFFICE });
    expect(visits()).toEqual([{ place_id: office, entered_at: iso(0), exited_at: iso(30) }]);
    step(db, at(3660), { gatewayMac: OFFICE });
    expect(visits()[1]).toEqual({ place_id: office, entered_at: iso(3630), exited_at: null });
  });

  it("does not log a place with logging off, and closes its open visit when switched off", () => {
    step(db, at(0), { gatewayMac: OFFICE });
    step(db, at(30), { gatewayMac: OFFICE });
    setLogging(userId, office, false);
    expect(visits()[0].exited_at).not.toBeNull();
    step(db, at(60), { gatewayMac: OFFICE });
    step(db, at(90), { gatewayMac: OFFICE });
    expect(visits()).toHaveLength(1);
    setLogging(userId, office, true);
    step(db, at(120), { gatewayMac: OFFICE });
    expect(visits()).toHaveLength(2);
    expect(visits()[1].exited_at).toBeNull();
  });

  it("stops logging a deleted place", () => {
    step(db, at(0), { gatewayMac: OFFICE });
    step(db, at(30), { gatewayMac: OFFICE });
    deletePlace(userId, office);
    step(db, at(60), { gatewayMac: OFFICE });
    step(db, at(90), { gatewayMac: OFFICE });
    expect(visits()).toHaveLength(1);
    expect(visits()[0].exited_at).not.toBeNull();
  });

  it("ignores networks no place claims", () => {
    step(db, at(0), { gatewayMac: "02:00:00:00:00:99" });
    step(db, at(30), { gatewayMac: "02:00:00:00:00:99" });
    expect(visits()).toEqual([]);
  });
});
