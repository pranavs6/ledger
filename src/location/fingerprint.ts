// Identifies the network the Mac is on, without Location Services.
//
// macOS 14.4+ redacts the Wi-Fi SSID for command-line tools, so the stable key
// is the MAC address of the default gateway: unprivileged to read, and fixed per
// router. The SSID is kept as a bonus when the OS does reveal it.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Fingerprint {
  iface?: string;
  gatewayIp?: string;
  /** Lowercase, zero-padded, colon-separated. The matching key. */
  gatewayMac?: string;
  ssid?: string;
  dnsDomain?: string;
}

export const fingerprintKey = (f: Fingerprint): string | null => f.gatewayMac ?? null;

export function describe(f: Fingerprint): string {
  if (!f.gatewayMac) return "No network";
  const name = f.ssid ?? f.dnsDomain;
  return name ? `${name} (router ${f.gatewayMac})` : `Router ${f.gatewayMac}`;
}

// ---------------------------------------------------------------- parsers

export function parseRoute(out: string): { gateway?: string; iface?: string } {
  const gateway = /^\s*gateway:\s*(\S+)/m.exec(out)?.[1];
  const iface = /^\s*interface:\s*(\S+)/m.exec(out)?.[1];
  return { gateway, iface };
}

/** macOS arp drops leading zeros ("0:1a:2:…"); pad so the key is canonical. */
export function normaliseMac(mac: string): string | undefined {
  const parts = mac.toLowerCase().split(":");
  if (parts.length !== 6 || !parts.every((p) => /^[0-9a-f]{1,2}$/.test(p))) return;
  return parts.map((p) => p.padStart(2, "0")).join(":");
}

export function parseArp(out: string): string | undefined {
  const m = / at ([0-9a-f:]+) /i.exec(out);
  return m ? normaliseMac(m[1]) : undefined;
}

export function parseSsid(ipconfigSummary: string): string | undefined {
  const ssid = /^\s*SSID\s*:\s*(.+?)\s*$/m.exec(ipconfigSummary)?.[1];
  return ssid && ssid !== "<redacted>" ? ssid : undefined;
}

const USELESS_DOMAIN = /(^local$|\.arpa$)/;

export function parseDnsDomain(scutil: string): string | undefined {
  for (const re of [/search domain\[\d+\]\s*:\s*(\S+)/g, /^\s*domain\s*:\s*(\S+)/gm]) {
    for (const m of scutil.matchAll(re)) if (!USELESS_DOMAIN.test(m[1])) return m[1];
  }
}

// ---------------------------------------------------------------- reader

async function sh(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(cmd, args, { timeout: 5000 });
    return stdout;
  } catch (e) {
    // arp exits 1 on "no entry" but still prints; anything else is just empty.
    return (e as { stdout?: string }).stdout ?? "";
  }
}

async function gatewayOn(iface?: string): Promise<{ gateway?: string; iface?: string }> {
  const args = iface ? ["-n", "get", "-ifscope", iface, "default"] : ["-n", "get", "default"];
  return parseRoute(await sh("/sbin/route", args));
}

async function macOf(ip: string): Promise<string | undefined> {
  let mac = parseArp(await sh("/usr/sbin/arp", ["-n", ip]));
  if (!mac) {
    // Cold ARP cache: one ping fills it.
    await sh("/sbin/ping", ["-c", "1", "-t", "1", ip]);
    mac = parseArp(await sh("/usr/sbin/arp", ["-n", ip]));
  }
  return mac;
}

/**
 * The default route first; if that is a VPN tunnel (utun, ipsec, ppp) or has no
 * MAC, fall back to each physical en* interface, so a full-tunnel work VPN
 * does not hide which office you are in.
 */
export async function readFingerprint(): Promise<Fingerprint> {
  const candidates: (string | undefined)[] = [undefined];
  const ifaces = (await sh("/sbin/ifconfig", ["-l"])).trim().split(/\s+/);
  candidates.push(...ifaces.filter((i) => /^en\d+$/.test(i)));

  for (const cand of candidates) {
    const { gateway, iface } = await gatewayOn(cand);
    if (!gateway || !iface || !/^en\d+$/.test(iface) || !/^[\d.]+$/.test(gateway)) continue;
    const gatewayMac = await macOf(gateway);
    if (!gatewayMac) continue;
    const [summary, dns] = await Promise.all([
      sh("/usr/sbin/ipconfig", ["getsummary", iface]),
      sh("/usr/sbin/scutil", ["--dns"]),
    ]);
    return { iface, gatewayIp: gateway, gatewayMac, ssid: parseSsid(summary), dnsDomain: parseDnsDomain(dns) };
  }
  return {};
}
