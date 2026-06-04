/**
 * adapters/antigravity-cli — Google Antigravity CLI (`agy`) adapter.
 *
 * `agy` is MCP-only for context-mode today. It shares the Gemini-family
 * mcp_config.json shape with Antigravity, but the CLI reads a distinct global
 * profile from `~/.gemini/config/mcp_config.json` per the local
 * agent-connector live verification. Project-local MCP remains
 * `.agents/mcp_config.json`, which setup does not target by default.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
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
        fix: "context-mode setup antigravity-cli",
      };
    }
  }

  getInstalledVersion(): string {
    return existsSync(this.getSettingsPath()) ? "configured" : "not installed";
  }
}
