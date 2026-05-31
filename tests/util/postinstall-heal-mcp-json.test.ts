/**
 * Issue #609 — scripts/postinstall.mjs MUST invoke sweepStaleMcpJson
 * alongside healPluginJsonMcpServers so users broken by Claude Code's
 * auto-update carry-forward (or by an earlier /ctx-upgrade tmpdir leak)
 * self-recover when they run `npm install -g context-mode`.
 *
 * History:
 *   v1.0.122 (#531) — postinstall ran `healMcpJsonArgs` per-entry to
 *   patch poisoned `.mcp.json` args. cli.ts also wrote `.mcp.json` at
 *   upgrade time then, so the heal was the right shape.
 *
 *   Issue #609 superseded that approach. cli.ts no longer writes `.mcp.json`
 *   (Claude Code reads `.claude-plugin/plugin.json.mcpServers` as the
 *   canonical source — upstream: mcpPluginIntegration.ts:131-212). The
 *   residual `.mcp.json` files in the cache are stale carry-forwards.
 *   Sweep them so the auto-update cannot replay them into a fresh dir.
 *
 *   Item B (this file's last rewrite) — the four heals consolidated into
 *   scripts/lib/heal/runtime-heal-suite.mjs. Both postinstall.mjs and
 *   start.mjs call runRuntimeHealSuite once instead of inlining 60+ lines
 *   apiece. The "MUST run" contract carries through two structural
 *   checks below: postinstall must wire the suite, AND the suite itself
 *   must call the four healers.
 *
 * Static-analysis sibling of start-mjs-self-heal.test.ts — fast,
 * deterministic, no integration spawn.
 */

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const postinstallSrc = readFileSync(resolve(ROOT, "scripts", "postinstall.mjs"), "utf-8");
const suiteSrc = readFileSync(
  resolve(ROOT, "scripts", "lib", "heal", "runtime-heal-suite.mjs"),
  "utf-8",
);

describe("scripts/postinstall.mjs wires the runtime heal suite", () => {
  test("imports + calls runRuntimeHealSuite from scripts/lib/heal/", () => {
    expect(postinstallSrc).toContain("runRuntimeHealSuite");
    expect(postinstallSrc).toMatch(/from\s+["']\.\/lib\/heal\/runtime-heal-suite/);
    // Must actually invoke it — presence of import alone is not enough.
    expect(postinstallSrc).toMatch(/runRuntimeHealSuite\(/);
  });

  test("calls the suite with phase: \"postinstall\"", () => {
    expect(postinstallSrc).toMatch(/phase\s*:\s*["']postinstall["']/);
  });

  test("call is wrapped defensively (try/catch, never blocks install)", () => {
    const idx = postinstallSrc.indexOf("runRuntimeHealSuite(");
    // Widen the window: the defensive comment lives in either the inner
    // try/catch around the suite call OR the helper-level "truly best
    // effort" comment in the outer stderr-write fallback.
    const block = postinstallSrc.slice(Math.max(0, idx - 400), idx + 1200);
    expect(block).toMatch(/try\s*\{/);
    expect(block).toMatch(/never block install|best effort|never crash|truly best effort|heal failure/i);
  });
});

describe("runtime-heal-suite.mjs runs all 4 layers (#46915 / #523 / #609)", () => {
  test("imports all 4 healers from heal-installed-plugins.mjs", () => {
    expect(suiteSrc).toMatch(/healInstalledPlugins/);
    expect(suiteSrc).toMatch(/healSettingsEnabledPlugins/);
    expect(suiteSrc).toMatch(/healPluginJsonMcpServers/);
    expect(suiteSrc).toMatch(/sweepStaleMcpJson/);
    expect(suiteSrc).toMatch(/heal-installed-plugins\.mjs/);
  });

  test("Layer 5b iterates EVERY installed cache entry's installPath (#523)", () => {
    // The healPluginJsonMcpServers section must loop over registry entries
    // and pass each entry.installPath. Otherwise multi-version installs
    // leave older poisoned caches untouched. Anchor on the FIRST occurrence
    // (the comment block) and grow the window to include the loop.
    const idx = suiteSrc.indexOf("Layer 5b");
    expect(idx).toBeGreaterThan(-1);
    const block = suiteSrc.slice(idx, idx + 2000);
    expect(block).toMatch(/for\s*\(/);
    expect(block).toContain("installPath");
    expect(block).toMatch(/healPluginJsonMcpServers\(/);
  });

  test("Layer 5c sweep is called once with pluginCacheRoot + pluginKey (#609)", () => {
    const idx = suiteSrc.lastIndexOf("sweepStaleMcpJson(");
    expect(idx).toBeGreaterThan(-1);
    const block = suiteSrc.slice(idx, idx + 400);
    expect(block).toContain("pluginCacheRoot");
    expect(block).toContain("pluginKey");
  });

  test("each layer is wrapped in its own try/catch — never throws upstream", () => {
    // The suite's contract is "best-effort, never throws". A failure in
    // Layer 5b (e.g. a corrupt installPath) must not skip Layer 5c.
    expect((suiteSrc.match(/try\s*\{/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
