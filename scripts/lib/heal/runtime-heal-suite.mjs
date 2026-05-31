/**
 * scripts/lib/heal/runtime-heal-suite — the 4-layer registry heal block
 * shared verbatim between `scripts/postinstall.mjs` and `start.mjs`.
 *
 * Both call sites previously inlined the same sequence:
 *   1. healInstalledPlugins         (HEAL 3 — per-entry version drift)
 *   2. healSettingsEnabledPlugins   (HEAL 4 — settings.json enabledPlugins)
 *   3. healPluginJsonMcpServers     (HEAL 5b — Issue #523 tmpdir baked in args)
 *   4. sweepStaleMcpJson            (HEAL 5c — Issue #609 stale .mcp.json sweep)
 *
 * Implements Item B of docs/setup-improvements.md. Single source of truth
 * for the suite; phase enum lets callers tune which side-effects are
 * acceptable (e.g. emitting stderr lines during postinstall vs staying
 * silent during MCP boot to avoid corrupting the JSON-RPC stream).
 *
 * Best-effort: never throws. Returns a structured report so callers can
 * log a single line of summary or hand it to the doctor command.
 *
 * Imports each healer from `scripts/heal-installed-plugins.mjs` (the
 * functions themselves stay there — they have independent unit tests in
 * `tests/util/heal-installed-plugins.test.ts`). This module is just the
 * orchestrator that callers wire instead of duplicating the for-loop.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  healInstalledPlugins,
  healSettingsEnabledPlugins,
  healPluginJsonMcpServers,
  sweepStaleMcpJson,
} from "../../heal-installed-plugins.mjs";
import { appendHealLog } from "./heal-log.mjs";

/**
 * @typedef {Object} RuntimeHealReport
 * @property {string[]} healed   - Layer names that mutated state.
 * @property {string[]} skipped  - Layer names that no-op'd (with reason in `notes`).
 * @property {string[]} errors   - Per-layer error messages (best-effort, never thrown).
 * @property {string[]} swept    - Absolute paths of `.mcp.json` files removed.
 * @property {string[]} notes    - Misc detail strings for log lines.
 */

/**
 * Run the 4-layer registry heal suite.
 *
 * @param {{
 *   pluginKey: string,            // typically "context-mode@context-mode"
 *   claudeConfigDir: string,      // resolved ~/.claude or $CLAUDE_CONFIG_DIR
 *   phase: "postinstall" | "mcp-boot",
 * }} opts
 * @returns {RuntimeHealReport}
 */
export function runRuntimeHealSuite({ pluginKey, claudeConfigDir, phase }) {
  /** @type {RuntimeHealReport} */
  const report = { healed: [], skipped: [], errors: [], swept: [], notes: [] };

  const registryPath = resolve(claudeConfigDir, "plugins", "installed_plugins.json");
  const pluginCacheRoot = resolve(claudeConfigDir, "plugins", "cache");
  const settingsPath = resolve(claudeConfigDir, "settings.json");

  // ── Layer 3 — installed_plugins.json version drift + enabledPlugins ──
  try {
    const r = healInstalledPlugins({ registryPath, pluginCacheRoot, pluginKey });
    if (r.healed && r.healed.length > 0) {
      report.healed.push(`installed_plugins.json (${r.healed.join(", ")})`);
    } else if (r.skipped) {
      report.skipped.push(`installed_plugins.json:${r.skipped}`);
    } else if (r.error) {
      report.errors.push(`installed_plugins.json: ${r.error}`);
    }
  } catch (err) {
    report.errors.push(`installed_plugins.json: ${(err && err.message) || err}`);
  }

  // ── Layer 4 — settings.json enabledPlugins ──
  try {
    const r = healSettingsEnabledPlugins({ settingsPath, pluginKey });
    if (r.healed && r.healed.length > 0) {
      report.healed.push(`settings.json (${r.healed.join(", ")})`);
    } else if (r.skipped) {
      report.skipped.push(`settings.json:${r.skipped}`);
    } else if (r.error) {
      report.errors.push(`settings.json: ${r.error}`);
    }
  } catch (err) {
    report.errors.push(`settings.json: ${(err && err.message) || err}`);
  }

  // ── Layer 5b — plugin.json mcpServers args (Issue #523) ──
  // Iterate EVERY installed cache entry's installPath so multi-version
  // installs all self-recover. Each call is independently wrapped because
  // one poisoned entry must not block heals on the others.
  try {
    if (existsSync(registryPath)) {
      const ip = JSON.parse(readFileSync(registryPath, "utf-8"));
      const entries = (ip && ip.plugins && ip.plugins[pluginKey]) || [];
      if (Array.isArray(entries)) {
        let healedCount = 0;
        for (const entry of entries) {
          const installPath = entry && entry.installPath;
          if (typeof installPath !== "string" || !installPath) continue;
          try {
            const r = healPluginJsonMcpServers({
              pluginRoot: installPath,
              pluginCacheRoot,
              pluginKey,
            });
            if (r && Array.isArray(r.healed) && r.healed.length > 0) {
              healedCount += 1;
            }
          } catch { /* per-entry best effort */ }
        }
        if (healedCount > 0) {
          report.healed.push(`plugin.json mcpServers (${healedCount} entry/entries, Issue #523)`);
        }
      }
    }
  } catch (err) {
    report.errors.push(`plugin.json mcpServers: ${(err && err.message) || err}`);
  }

  // ── Layer 5c — sweep stale .mcp.json (Issue #609) ──
  // One sweep per boot — bounded, idempotent, best-effort.
  try {
    const r = sweepStaleMcpJson({ pluginCacheRoot, pluginKey });
    if (r && Array.isArray(r.removed) && r.removed.length > 0) {
      report.swept.push(...r.removed);
      report.healed.push(`stale .mcp.json (${r.removed.length} file/files swept, Issue #609)`);
    }
  } catch (err) {
    report.errors.push(`mcp.json sweep: ${(err && err.message) || err}`);
  }

  // Phase note — useful for telemetry / doctor surface.
  report.notes.push(`phase=${phase}`);

  // Item B4 — append one JSON line to ${claudeConfigDir}/context-mode/heal.log.
  // Best-effort: never throws, never blocks. doctor reads the same file to
  // surface "HEAL ran N times in the last 7 days, healed X of them".
  appendHealLog({
    claudeConfigDir,
    entry: {
      phase,
      healed: report.healed,
      skipped: report.skipped,
      errors: report.errors,
      sweptCount: report.swept.length,
    },
  });

  return report;
}
