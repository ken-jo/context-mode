/**
 * Item B4 — scripts/lib/heal/heal-log.mjs behavior contract.
 *
 * The JSON-Lines ledger is what makes `context-mode doctor` honest about
 * heal frequency. Without it, a Claude Code auto-update regression that
 * forces a heal on every boot would surface to users as a vague "doctor
 * said PASS" instead of a clear "13/14 runs in the last week mutated
 * state — something upstream is broken".
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  appendHealLog,
  readHealLog,
  summarizeHealLog,
} from "../../scripts/lib/heal/heal-log.mjs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tmps: string[] = [];
function mkTmp(prefix = "ctx-heal-log-test-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}
afterEach(() => {
  while (tmps.length) {
    const d = tmps.pop();
    if (d) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
});

describe("heal-log", () => {
  it("appendHealLog creates the parent dir + writes one JSON line per call", () => {
    const dir = mkTmp();
    appendHealLog({
      claudeConfigDir: dir,
      entry: {
        phase: "postinstall",
        healed: ["installed_plugins.json"],
        skipped: [],
        errors: [],
        sweptCount: 0,
      },
    });
    appendHealLog({
      claudeConfigDir: dir,
      entry: {
        phase: "mcp-boot",
        healed: [],
        skipped: ["installed_plugins.json:no-registry"],
        errors: [],
        sweptCount: 0,
      },
    });
    const logPath = resolve(dir, "context-mode", "heal.log");
    expect(existsSync(logPath)).toBe(true);
    const text = readFileSync(logPath, "utf-8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const obj = JSON.parse(line);
      expect(typeof obj.ts).toBe("string");
      expect(["postinstall", "mcp-boot"]).toContain(obj.phase);
    }
  });

  it("readHealLog parses the ledger and respects sinceMs", () => {
    const dir = mkTmp();
    appendHealLog({
      claudeConfigDir: dir,
      entry: {
        ts: "2020-01-01T00:00:00.000Z",
        phase: "postinstall",
        healed: [],
        skipped: [],
        errors: [],
        sweptCount: 0,
      },
    });
    appendHealLog({
      claudeConfigDir: dir,
      entry: {
        ts: "2030-01-01T00:00:00.000Z",
        phase: "mcp-boot",
        healed: ["x"],
        skipped: [],
        errors: [],
        sweptCount: 0,
      },
    });
    const all = readHealLog({ claudeConfigDir: dir });
    expect(all.length).toBe(2);
    const recent = readHealLog({
      claudeConfigDir: dir,
      sinceMs: Date.parse("2025-01-01T00:00:00.000Z"),
    });
    expect(recent.length).toBe(1);
    expect(recent[0].phase).toBe("mcp-boot");
  });

  it("summarizeHealLog returns null on empty log", () => {
    const dir = mkTmp();
    expect(summarizeHealLog({ claudeConfigDir: dir })).toBeNull();
  });

  it("summarizeHealLog aggregates healed/errors/swept + per-phase counts", () => {
    const dir = mkTmp();
    const now = new Date().toISOString();
    appendHealLog({
      claudeConfigDir: dir,
      entry: {
        ts: now,
        phase: "postinstall",
        healed: ["installed_plugins.json"],
        skipped: [],
        errors: [],
        sweptCount: 0,
      },
    });
    appendHealLog({
      claudeConfigDir: dir,
      entry: {
        ts: now,
        phase: "mcp-boot",
        healed: [],
        skipped: ["installed_plugins.json:no-registry"],
        errors: [],
        sweptCount: 0,
      },
    });
    appendHealLog({
      claudeConfigDir: dir,
      entry: {
        ts: now,
        phase: "mcp-boot",
        healed: [],
        skipped: [],
        errors: ["filesystem busy"],
        sweptCount: 3,
      },
    });
    const summary = summarizeHealLog({ claudeConfigDir: dir });
    expect(summary).not.toBeNull();
    expect(summary!.total).toBe(3);
    expect(summary!.healed).toBe(1);
    expect(summary!.skippedOnly).toBe(1);
    expect(summary!.errors).toBe(1);
    expect(summary!.swept).toBe(3);
    expect(summary!.lastPhases.postinstall).toBe(1);
    expect(summary!.lastPhases["mcp-boot"]).toBe(2);
  });

  it("ledger is capped — rotation keeps it within the hysteresis bound", () => {
    const dir = mkTmp();
    // Write well past the rotation trigger (MAX_LINES * 1.2 = 600). Rotation
    // fires at >600 and trims to 500, so the steady-state ceiling is 600.
    for (let i = 0; i < 700; i++) {
      appendHealLog({
        claudeConfigDir: dir,
        entry: {
          phase: "mcp-boot",
          healed: [],
          skipped: [],
          errors: [],
          sweptCount: 0,
        },
      });
    }
    const all = readHealLog({ claudeConfigDir: dir });
    // Bounded (rotation happened) and not unbounded growth at 700.
    expect(all.length).toBeLessThanOrEqual(600);
    expect(all.length).toBeGreaterThanOrEqual(500);
  });

  it("malformed lines are skipped silently — readHealLog never throws", () => {
    const dir = mkTmp();
    appendHealLog({
      claudeConfigDir: dir,
      entry: {
        phase: "mcp-boot",
        healed: [],
        skipped: [],
        errors: [],
        sweptCount: 0,
      },
    });
    // Corrupt the log mid-stream.
    const logPath = resolve(dir, "context-mode", "heal.log");
    const text = readFileSync(logPath, "utf-8");
    require("node:fs").appendFileSync(logPath, "this is not json\n", "utf-8");
    require("node:fs").appendFileSync(logPath, text, "utf-8"); // second valid line
    const entries = readHealLog({ claudeConfigDir: dir });
    expect(entries.length).toBe(2); // 2 valid, 1 skipped malformed
  });
});
