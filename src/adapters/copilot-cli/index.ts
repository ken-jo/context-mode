/**
 * adapters/copilot-cli — GitHub Copilot CLI adapter.
 *
 * Native config:
 *   - MCP:   $COPILOT_HOME/mcp-config.json or ~/.copilot/mcp-config.json
 *            under root key `mcpServers`.
 *   - Hooks: $COPILOT_HOME/hooks/context-mode.json or
 *            ~/.copilot/hooks/context-mode.json.
 *
 * Hooks are VS Code-compatible PascalCase event keys with flat
 * `{ type, command }` entries, but Copilot CLI's command output contract is
 * top-level (`permissionDecision`, `modifiedArgs`, `additionalContext`), so
 * this adapter overrides the response formatter from CopilotBaseAdapter.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { CopilotBaseAdapter } from "../copilot-base.js";
import type { CopilotHookInput, CopilotHookModule } from "../copilot-base.js";
import { parseJsonc } from "../../util/jsonc.js";
import type {
  DiagnosticResult,
  PostToolUseResponse,
  PreCompactResponse,
  PostToolUseEvent,
  PreToolUseEvent,
  PreToolUseResponse,
  SessionStartResponse,
} from "../types.js";

import {
  HOOK_TYPES as COPILOT_HOOK_NAMES,
  HOOK_SCRIPTS as COPILOT_HOOK_SCRIPTS,
  buildHookCommand as buildCopilotHookCommand,
} from "./hooks.js";

export function copilotCliHome(): string {
  const raw = process.env.COPILOT_HOME;
  if (raw && raw.trim() !== "") {
    if (raw.startsWith("~")) {
      return join(homedir(), raw.replace(/^~[/\\]?/, ""));
    }
    return resolve(raw);
  }
  return join(homedir(), ".copilot");
}

export function copilotCliMcpConfigPath(): string {
  return join(copilotCliHome(), "mcp-config.json");
}

export class CopilotCliAdapter extends CopilotBaseAdapter {
  constructor() {
    super([".copilot"]);
  }

  readonly name = "GitHub Copilot CLI";

  protected readonly hookModule: CopilotHookModule = {
    HOOK_TYPES: COPILOT_HOOK_NAMES,
    HOOK_SCRIPTS: COPILOT_HOOK_SCRIPTS,
    buildHookCommand: buildCopilotHookCommand,
  };

  protected readonly hookSubdir = "copilot-cli";

  protected extractSessionId(input: CopilotHookInput): string {
    const raw = input as CopilotHookInput & {
      session_id?: string;
      conversation_id?: string;
      transcript_path?: string;
    };
    if (raw.transcript_path) {
      const match = raw.transcript_path.match(/([a-f0-9-]{36})\.jsonl$/);
      if (match) return match[1];
    }
    if (raw.conversation_id) return raw.conversation_id;
    if (input.sessionId) return input.sessionId;
    if (raw.session_id) return raw.session_id;
    return `pid-${process.ppid}`;
  }

  protected getProjectDir(): string {
    return process.cwd();
  }

  parsePreToolUseInput(raw: unknown): PreToolUseEvent {
    const input = raw as CopilotHookInput & {
      cwd?: string;
      toolName?: string;
      toolArgs?: Record<string, unknown>;
    };
    return {
      toolName: input.tool_name ?? input.toolName ?? "",
      toolInput: input.tool_input ?? input.toolArgs ?? {},
      sessionId: this.extractSessionId(input),
      projectDir: typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd(),
      raw,
    };
  }

  parsePostToolUseInput(raw: unknown): PostToolUseEvent {
    const input = raw as CopilotHookInput & {
      cwd?: string;
      toolName?: string;
      toolArgs?: Record<string, unknown>;
      tool_result?: { text_result_for_llm?: string };
      toolResult?: { textResultForLlm?: string };
      tool_response?: unknown;
    };
    const output =
      input.tool_result?.text_result_for_llm ??
      input.toolResult?.textResultForLlm ??
      (typeof input.tool_response === "string" ? input.tool_response : undefined) ??
      input.tool_output;
    return {
      toolName: input.tool_name ?? input.toolName ?? "",
      toolInput: input.tool_input ?? input.toolArgs ?? {},
      toolOutput: output,
      isError: input.is_error,
      sessionId: this.extractSessionId(input),
      projectDir: typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd(),
      raw,
    };
  }

  getSettingsPath(_projectDir?: string): string {
    return join(copilotCliHome(), "hooks", "context-mode.json");
  }

  getConfigDir(_projectDir?: string): string {
    return copilotCliHome();
  }

  getInstructionFiles(): string[] {
    return [".github/copilot-instructions.md", "AGENTS.md"];
  }

  readSettings(): Record<string, unknown> | null {
    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      return parseJsonc<Record<string, unknown>>(raw) ?? null;
    } catch {
      return null;
    }
  }

  formatPreToolUseResponse(response: PreToolUseResponse): unknown {
    if (response.decision === "deny") {
      return {
        permissionDecision: "deny",
        permissionDecisionReason: response.reason ?? "Blocked by context-mode hook",
      };
    }
    if (response.decision === "ask") {
      return {
        permissionDecision: "ask",
        permissionDecisionReason: response.reason ?? "Action requires user confirmation",
      };
    }
    if (response.decision === "modify" && response.updatedInput) {
      return { modifiedArgs: response.updatedInput };
    }
    if (response.decision === "context" && response.additionalContext) {
      return { additionalContext: response.additionalContext };
    }
    return undefined;
  }

  formatPostToolUseResponse(response: PostToolUseResponse): unknown {
    if (response.updatedOutput) {
      return {
        modifiedResult: {
          resultType: "success",
          textResultForLlm: response.updatedOutput,
        },
      };
    }
    if (response.additionalContext) {
      return { additionalContext: response.additionalContext };
    }
    return undefined;
  }

  formatPreCompactResponse(response: PreCompactResponse): unknown {
    void response;
    return undefined;
  }

  formatSessionStartResponse(response: SessionStartResponse): unknown {
    return response.context ? { additionalContext: response.context } : undefined;
  }

  validateHooks(_pluginRoot: string): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];

    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      const config = parseJsonc<Record<string, unknown>>(raw) ?? {};
      const hooks = config.hooks as Record<string, unknown> | undefined;

      results.push({
        check: "Hooks schema version",
        status: config.version === 1 ? "pass" : "fail",
        message: config.version === 1
          ? 'context-mode.json declares the required "version": 1'
          : 'context-mode.json is missing top-level "version": 1',
        ...(config.version === 1 ? {} : { fix: "context-mode setup copilot-cli" }),
      });

      for (const hookName of [COPILOT_HOOK_NAMES.PRE_TOOL_USE, COPILOT_HOOK_NAMES.SESSION_START]) {
        const configured = Array.isArray(hooks?.[hookName]) && (hooks?.[hookName] as unknown[]).length > 0;
        results.push({
          check: `${hookName} hook`,
          status: configured ? "pass" : "fail",
          message: configured
            ? `${hookName} hook configured in ${this.getSettingsPath()}`
            : `${hookName} not found in ${this.getSettingsPath()}`,
          ...(configured ? {} : { fix: "context-mode setup copilot-cli" }),
        });
      }
    } catch {
      results.push({
        check: "Hook configuration",
        status: "fail",
        message: `Could not read ${this.getSettingsPath()}`,
        fix: "context-mode setup copilot-cli",
      });
    }

    return results;
  }

  checkPluginRegistration(): DiagnosticResult {
    try {
      const raw = readFileSync(copilotCliMcpConfigPath(), "utf-8");
      const config = parseJsonc<Record<string, unknown>>(raw) ?? {};
      const mcpServers = (config?.mcpServers as Record<string, unknown>) ?? {};
      if ("context-mode" in mcpServers) {
        return {
          check: "MCP registration",
          status: "pass",
          message: "context-mode found in Copilot CLI mcp-config.json",
        };
      }
      return {
        check: "MCP registration",
        status: "fail",
        message: "context-mode not found in Copilot CLI mcpServers",
        fix: "context-mode setup copilot-cli",
      };
    } catch {
      return {
        check: "MCP registration",
        status: "fail",
        message: `Could not read ${copilotCliMcpConfigPath()}`,
        fix: "context-mode setup copilot-cli",
      };
    }
  }

  getInstalledVersion(): string {
    return existsSync(copilotCliMcpConfigPath()) || existsSync(this.getSettingsPath())
      ? "configured"
      : "not installed";
  }
}
