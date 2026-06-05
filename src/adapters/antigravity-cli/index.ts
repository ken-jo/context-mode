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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      const config = parseJsonc<Record<string, unknown>>(raw) ?? {};
      const mcpServers = (config?.mcpServers as Record<string, unknown>) ?? {};

      if ("context-mode" in mcpServers) {
        return {
          check: "MCP registration",
          status: "pass",
          message: "context-mode found in Antigravity CLI mcpServers config",
        };
      }

      return {
        check: "MCP registration",
        status: "fail",
        message: "context-mode not found in Antigravity CLI mcpServers",
        fix: `Add context-mode to mcpServers in ${this.getSettingsPath()}`,
      };
    } catch {
      return {
        check: "MCP registration",
        status: "fail",
        message: `Could not read ${this.getSettingsPath()}`,
        fix: `Add context-mode to mcpServers in ${this.getSettingsPath()}`,
      };
    }
  }

  getInstalledVersion(): string {
    return existsSync(this.getSettingsPath()) ? "configured" : "not installed";
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
    const hooksPath = antigravityCliHooksPath();
    try {
      const config = parseJsonc<Record<string, unknown>>(readFileSync(hooksPath, "utf-8")) ?? {};
      const hooks = (config.hooks as Record<string, unknown> | undefined) ?? {};
      const configured =
        Array.isArray(hooks.PostToolUse) &&
        JSON.stringify(hooks.PostToolUse).includes("antigravity-cli posttooluse");
      return [
        {
          check: "PostToolUse capture hook",
          status: configured ? "pass" : "warn",
          message: configured
            ? `PostToolUse capture hook configured in ${hooksPath} (capture-only — enforcement is via the routing skill)`
            : "Capture hook not configured — MCP tools still work. Install the agy plugin (configs/antigravity-cli) or run `context-mode upgrade` to enable session capture. agy hooks are capture-only (no blocking).",
          ...(configured ? {} : { fix: "context-mode upgrade" }),
        },
      ];
    } catch {
      return [
        {
          check: "PostToolUse capture hook",
          status: "warn",
          message:
            "Capture hook not configured — MCP-only until set up. agy hooks are capture-only (no blocking).",
          fix: "context-mode upgrade",
        },
      ];
    }
  }
}
