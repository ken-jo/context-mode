/**
 * adapters/antigravity-cli — Google Antigravity CLI (`agy`) adapter.
 *
 * Enforcement: MCP-only (the routing skill / instructions are the only
 * enforcement — agy honors no PreToolUse stdout veto in auto-run mode, verified
 * against agy 1.0.5). `agy` reads its global MCP profile from
 * `~/.gemini/config/mcp_config.json` (distinct from the Antigravity IDE's
 * `~/.gemini/antigravity/mcp_config.json`).
 *
 * Capture: agy DOES fire `PostToolUse` hooks (config at
 * `~/.gemini/config/hooks.json`, or an installed agy plugin's
 * `hooks/hooks.json`). context-mode wires a capture-only PostToolUse hook
 * (`context-mode hook antigravity-cli posttooluse`) that records tool usage
 * into the session DB. The richest install is `agy plugin install`/`import` of
 * the bundle in `configs/antigravity-cli/`, which brings MCP + the routing
 * skill + this capture hook in one step.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

import { AntigravityAdapter } from "../antigravity/index.js";
import { parseJsonc } from "../../util/jsonc.js";
import type { DiagnosticResult } from "../types.js";

export function antigravityCliMcpConfigPath(): string {
  return resolve(homedir(), ".gemini", "config", "mcp_config.json");
}

export function antigravityCliConfigDir(): string {
  return resolve(homedir(), ".gemini", "antigravity-cli");
}

/** agy reads user hooks from ~/.gemini/config/hooks.json (sibling of mcp_config.json). */
export function antigravityCliHooksPath(): string {
  return resolve(homedir(), ".gemini", "config", "hooks.json");
}

/**
 * `agy plugin install <bundle>` registers MCP + hook + skill into agy's plugin
 * profile under ~/.gemini/config/plugins/<name>/ (verified on agy 1.0.6) — the
 * canonical install. The global mcp_config.json / hooks.json paths above are the
 * manual (no-plugin) fallback. doctor must recognize BOTH.
 */
export function antigravityCliPluginDir(): string {
  return resolve(homedir(), ".gemini", "config", "plugins", "context-mode");
}
function antigravityCliPluginMcpPath(): string {
  return resolve(antigravityCliPluginDir(), "mcp_config.json");
}
function antigravityCliPluginHooksPath(): string {
  return resolve(antigravityCliPluginDir(), "hooks.json");
}

/** True if context-mode's MCP is registered in any agy profile (plugin or global). */
function readMcpRegistered(paths: string[]): { ok: boolean; where?: string } {
  for (const path of paths) {
    try {
      const config = parseJsonc<Record<string, unknown>>(readFileSync(path, "utf-8")) ?? {};
      const mcpServers = (config?.mcpServers as Record<string, unknown>) ?? {};
      if ("context-mode" in mcpServers) return { ok: true, where: path };
    } catch {
      /* unreadable/missing — try next */
    }
  }
  return { ok: false };
}

/** True if the capture hook is registered in any agy hooks profile (plugin or global). */
function readCaptureHook(paths: string[]): { ok: boolean; where?: string } {
  for (const path of paths) {
    try {
      const config = parseJsonc<Record<string, unknown>>(readFileSync(path, "utf-8")) ?? {};
      const hooks = (config.hooks as Record<string, unknown> | undefined) ?? {};
      if (
        Array.isArray(hooks.PostToolUse) &&
        JSON.stringify(hooks.PostToolUse).includes("antigravity-cli posttooluse")
      ) {
        return { ok: true, where: path };
      }
    } catch {
      /* unreadable/missing — try next */
    }
  }
  return { ok: false };
}

/** Dispatcher command agy invokes for the capture hook. */
const CAPTURE_HOOK_COMMAND = "context-mode hook antigravity-cli posttooluse";

export class AntigravityCliAdapter extends AntigravityAdapter {
  readonly name = "Antigravity CLI";

  getSettingsPath(): string {
    return antigravityCliMcpConfigPath();
  }

  getConfigDir(_projectDir?: string): string {
    return antigravityCliConfigDir();
  }

  checkPluginRegistration(): DiagnosticResult {
    // Accept the plugin profile (the canonical `agy plugin install` location,
    // ~/.gemini/config/plugins/context-mode/mcp_config.json) OR the global
    // mcp_config.json (the manual no-plugin fallback).
    const { ok, where } = readMcpRegistered([
      antigravityCliPluginMcpPath(),
      this.getSettingsPath(),
    ]);
    if (ok) {
      return {
        check: "MCP registration",
        status: "pass",
        message: `context-mode found in Antigravity CLI mcpServers (${where})`,
      };
    }
    return {
      check: "MCP registration",
      status: "fail",
      message: "context-mode not found in Antigravity CLI mcpServers",
      fix: "npm run install:agy",
    };
  }

  getInstalledVersion(): string {
    // Plugin install: read the real version from the installed plugin manifest so
    // the doctor compares a true semver against npm latest (PASS when current,
    // a meaningful "outdated bundle" WARN otherwise) — not the literal "configured"
    // which produced the bogus "vconfigured, latest vX" line.
    try {
      const manifest = parseJsonc<Record<string, unknown>>(
        readFileSync(resolve(antigravityCliPluginDir(), "plugin.json"), "utf-8"),
      );
      if (manifest && typeof manifest.version === "string" && manifest.version) {
        return manifest.version;
      }
    } catch {
      /* not plugin-installed — fall through */
    }
    // Manual (global-profile) registration has no plugin manifest: report the
    // version-less "standalone" MCP mode so doctor shows INFO, not a false WARN.
    if (readMcpRegistered([this.getSettingsPath()]).ok) return "standalone";
    return "not installed";
  }

  /**
   * Write/merge the capture-only PostToolUse hook into ~/.gemini/config/hooks.json
   * (the direct, non-plugin path). agy ignores hook stdout in auto-run mode, so
   * this records tool usage but never blocks. Idempotent — existing/other hooks
   * are preserved.
   */
  configureAllHooks(_pluginRoot: string): string[] {
    const changes: string[] = [];
    const hooksPath = antigravityCliHooksPath();

    let config: Record<string, unknown> = {};
    try {
      config = parseJsonc<Record<string, unknown>>(readFileSync(hooksPath, "utf-8")) ?? {};
    } catch {
      /* fresh file */
    }

    const hooks = (config.hooks as Record<string, unknown> | undefined) ?? {};
    const desired = [
      { matcher: "", hooks: [{ type: "command", command: CAPTURE_HOOK_COMMAND }] },
    ];

    if (JSON.stringify(hooks.PostToolUse) !== JSON.stringify(desired)) {
      hooks.PostToolUse = desired;
      config.hooks = hooks;
      mkdirSync(dirname(hooksPath), { recursive: true });
      writeFileSync(hooksPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
      changes.push(`Configured PostToolUse capture hook in ${hooksPath}`);
    }

    return changes;
  }

  /** Report capture-hook status honestly (capture-only; enforcement is the routing skill). */
  validateHooks(_pluginRoot: string): DiagnosticResult[] {
    // Accept the plugin profile (the canonical `agy plugin install` location,
    // ~/.gemini/config/plugins/context-mode/hooks.json) OR the global hooks.json
    // (the manual `context-mode upgrade` fallback).
    const { ok, where } = readCaptureHook([
      antigravityCliPluginHooksPath(),
      antigravityCliHooksPath(),
    ]);
    return [
      {
        check: "PostToolUse capture hook",
        status: ok ? "pass" : "warn",
        message: ok
          ? `PostToolUse capture hook configured in ${where} (capture-only — enforcement is via the routing skill)`
          : "Capture hook not configured — MCP tools still work. Run `npm run install:agy` (agy plugin) or `context-mode upgrade` to enable session capture. agy hooks are capture-only (no blocking).",
        ...(ok ? {} : { fix: "npm run install:agy" }),
      },
    ];
  }
}
