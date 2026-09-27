import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { agentPlist } from "../src/launchd.ts";

describe("launch agents", () => {
  it.skipIf(process.platform !== "darwin")("writes a valid property list, escaping paths", () => {
    const xml = agentPlist(
      "dev.ledger.locator",
      ["/Users/me/Library/Application Support/ledger/Ledger Locator.app/Contents/MacOS/LedgerLocator", "--url", "http://127.0.0.1:4545"],
      "/tmp/ledger & co.log",
      { PATH: "/usr/bin:/bin" },
      "/Users/me/ledger",
    );
    expect(xml).toContain("/tmp/ledger &amp; co.log");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ledger-")), "a.plist");
    fs.writeFileSync(file, xml);
    expect(execFileSync("plutil", ["-lint", file]).toString()).toContain("OK");
    const json = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", file]).toString());
    expect(json.ProgramArguments[1]).toBe("--url");
    expect(json.KeepAlive).toBe(true);
    expect(json.WorkingDirectory).toBe("/Users/me/ledger");
  });
});
