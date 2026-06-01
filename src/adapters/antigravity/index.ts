/**
 * adapters/antigravity — Google Antigravity platform adapter.
 *
 * Implements HookAdapter for Antigravity's MCP-only paradigm.
 *
 * Antigravity hook specifics:
 *   - NO hook support (MCP-only, same as Codex CLI)
 *   - Editor config: ~/.gemini/antigravity/mcp_config.json (JSON format)
 *   - CLI config: ~/.gemini/antigravity-cli/mcp_config.json (when ANTIGRAVITY_CLI_ALIAS is set)
 *   - MCP: full support via mcpServers in mcp_config.json
 *   - All capabilities are false — MCP is the only integration path
 *   - Session dir: ~/.gemini/context-mode/sessions/
 *   - Routing file: GEMINI.md (shared with Gemini CLI filename, different content)
 *
 * Sources:
 *   - Config path: https://github.com/google-gemini/gemini-cli/issues/16058
 *   - MCP support: https://antigravity.google/docs/mcp
 *   - Tool list: System prompt leak (21 verified tools)
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { BaseAdapter } from "../base.js";
import { parseJsonc } from "../../util/jsonc.js";

export function antigravityMcpConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(
    homedir(),
    ".gemini",
    env.ANTIGRAVITY_CLI_ALIAS ? "antigravity-cli" : "antigravity",
    "mcp_config.json",
  );
}

export function antigravityConfigDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(
    homedir(),
    ".gemini",
    env.ANTIGRAVITY_CLI_ALIAS ? "antigravity-cli" : "antigravity",
  );
}

import type {
  HookAdapter,
  HookParadigm,
  PlatformCapabilities,
  DiagnosticResult,
  PreToolUseEvent,
  PostToolUseEvent,
  PreCompactEvent,
  SessionStartEvent,
  PreToolUseResponse,
  PostToolUseResponse,
  PreCompactResponse,
  SessionStartResponse,
  HookRegistration,
} from "../types.js";

// ─────────────────────────────────────────────────────────
// Adapter implementation
// ─────────────────────────────────────────────────────────

export class AntigravityAdapter extends BaseAdapter implements HookAdapter {
  constructor() {
    super([".gemini"]);
  }

  readonly name = "Antigravity";
  readonly paradigm: HookParadigm = "mcp-only";

  readonly capabilities: PlatformCapabilities = {
    preToolUse: false,
    postToolUse: false,
    preCompact: false,
    sessionStart: false,
    canModifyArgs: false,
    canModifyOutput: false,
    canInjectSessionContext: false,
  };

  // ── Input parsing ──────────────────────────────────────
  // Antigravity does not support hooks. These methods exist to satisfy the
  // interface contract but will throw if called.

  parsePreToolUseInput(_raw: unknown): PreToolUseEvent {
    throw new Error("Antigravity does not support hooks");
  }

  parsePostToolUseInput(_raw: unknown): PostToolUseEvent {
    throw new Error("Antigravity does not support hooks");
  }

  parsePreCompactInput(_raw: unknown): PreCompactEvent {
    throw new Error("Antigravity does not support hooks");
  }

  parseSessionStartInput(_raw: unknown): SessionStartEvent {
    throw new Error("Antigravity does not support hooks");
  }

  // ── Response formatting ────────────────────────────────
  // Antigravity does not support hooks. Return undefined for all responses.

  formatPreToolUseResponse(_response: PreToolUseResponse): unknown {
    return undefined;
  }

  formatPostToolUseResponse(_response: PostToolUseResponse): unknown {
    return undefined;
  }

  formatPreCompactResponse(_response: PreCompactResponse): unknown {
    return undefined;
  }

  formatSessionStartResponse(_response: SessionStartResponse): unknown {
    return undefined;
  }

  // ── Configuration ──────────────────────────────────────

  getSettingsPath(): string {
    return antigravityMcpConfigPath();
  }

  /**
   * Antigravity nests under either ~/.gemini/antigravity/ or
   * ~/.gemini/antigravity-cli/. Always absolute.
   * `_projectDir` accepted for interface symmetry but unused — home-rooted.
   */
  getConfigDir(_projectDir?: string): string {
    return antigravityConfigDir();
  }

  getInstructionFiles(): string[] {
    return ["GEMINI.md"];
  }

  generateHookConfig(_pluginRoot: string): HookRegistration {
    return {};
  }

  readSettings(): Record<string, unknown> | null {
    // Antigravity mcp_config.json is JSONC (shares Gemini's config
    // family) — parse tolerantly to match setup. (Loop-4 consistency fix.)
    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      return parseJsonc<Record<string, unknown>>(raw) ?? null;
    } catch {
      return null;
    }
  }

  writeSettings(settings: Record<string, unknown>): void {
    const settingsPath = this.getSettingsPath();
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  }

  // ── Diagnostics (doctor) ─────────────────────────────────

  validateHooks(_pluginRoot: string): DiagnosticResult[] {
    return [
      {
        check: "Hook support",
        status: "warn",
        message:
          "Antigravity does not support hooks. " +
          "Only MCP integration is available.",
      },
    ];
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
          message: "context-mode found in mcpServers config",
        };
      }

      return {
        check: "MCP registration",
        status: "fail",
        message: "context-mode not found in mcpServers",
        fix: `Add context-mode to mcpServers in ${this.getSettingsPath()}`,
      };
    } catch {
      return {
        check: "MCP registration",
        status: "fail",
        message: `Could not read ${this.getSettingsPath()}`,
        fix: "context-mode setup antigravity",
      };
    }
  }

  getInstalledVersion(): string {
    try {
      const pkgPath = resolve(
        homedir(),
        ".gemini",
        "extensions",
        "context-mode",
        "package.json",
      );
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      return pkg.version ?? "unknown";
    } catch {
      return "not installed";
    }
  }

  // ── Upgrade ────────────────────────────────────────────

  configureAllHooks(_pluginRoot: string): string[] {
    return [];
  }



  setHookPermissions(_pluginRoot: string): string[] {
    return [];
  }

  updatePluginRegistry(_pluginRoot: string, _version: string): void {
    // Antigravity plugin registry is managed via mcp_config.json
  }

  getRoutingInstructions(): string {
    const instructionsPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "configs",
      "antigravity",
      "GEMINI.md",
    );
    try {
      return readFileSync(instructionsPath, "utf-8");
    } catch {
      return "# context-mode\n\nUse context-mode MCP tools (execute, execute_file, batch_execute, fetch_and_index, search) instead of run_command/view_file for data-heavy operations.";
    }
  }
}
