import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { describe as describeFp, normaliseMac, parseArp, parseDnsDomain, parseRoute, parseSsid } from "../src/location/fingerprint.ts";

const fixture = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("fingerprint parsers", () => {
  it("reads gateway and interface from route", () => {
    expect(parseRoute(fixture("route-default.txt"))).toEqual({ gateway: "192.168.0.1", iface: "en0" });
    expect(parseRoute("route: writing to routing socket: not in table")).toEqual({ gateway: undefined, iface: undefined });
  });

  it("reads and pads the gateway MAC from arp", () => {
    expect(parseArp(fixture("arp.txt"))).toBe("02:00:00:aa:bb:cc");
    expect(parseArp(fixture("arp-short.txt"))).toBe("00:1a:2b:03:4c:5d");
    expect(parseArp("10.9.9.9 (10.9.9.9) -- no entry")).toBeUndefined();
  });

  it("rejects malformed MACs", () => {
    expect(normaliseMac("(incomplete)")).toBeUndefined();
    expect(normaliseMac("aa:bb:cc")).toBeUndefined();
  });

  it("treats a redacted SSID as unknown, and ignores BSSID", () => {
    expect(parseSsid(fixture("ipconfig-redacted.txt"))).toBeUndefined();
    expect(parseSsid(fixture("ipconfig-ssid.txt"))).toBe("Office-5G");
  });

  it("prefers the search domain and skips mDNS domains", () => {
    expect(parseDnsDomain(fixture("scutil-corp.txt"))).toBe("corp.example.com");
    expect(parseDnsDomain(fixture("scutil-dns.txt"))).toBeUndefined();
  });

  it("describes a fingerprint for people", () => {
    expect(describeFp({})).toBe("No network");
    expect(describeFp({ gatewayMac: "02:00:00:aa:bb:cc" })).toBe("Router 02:00:00:aa:bb:cc");
    expect(describeFp({ gatewayMac: "02:00:00:aa:bb:cc", ssid: "Office-5G" })).toBe("Office-5G (router 02:00:00:aa:bb:cc)");
  });
});
