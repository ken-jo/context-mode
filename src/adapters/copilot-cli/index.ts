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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { CopilotBaseAdapter } from "../copilot-base.js";
import type { CopilotHookInput, CopilotHookModule } from "../copilot-base.js";
import { resolveContextModeDataRoot } from "../base.js";
import { parseJsonc } from "../../util/jsonc.js";
import type {
  DiagnosticResult,
  HookRegistration,
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

  getSessionDir(): string {
    // Parity with codex/kimi: honor CONTEXT_MODE_DATA_DIR first, else root
    // session storage at getConfigDir() (= copilotCliHome(), COPILOT_HOME-aware)
    // so the TS server reads sessions from the SAME place the hook runtime
    // (COPILOT_OPTS configDirEnv: "COPILOT_HOME") writes them. Without this, a
    // relocated COPILOT_HOME splits hook writes ($COPILOT_HOME/...) from server
    // reads (~/.copilot/...) and sessions appear empty/orphaned.
    const override = resolveContextModeDataRoot();
    const dir = override
      ? join(override, "context-mode", "sessions")
      : join(this.getConfigDir(), "context-mode", "sessions");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  getInstructionFiles(): string[] {
    return [".github/copilot-instructions.md", "AGENTS.md"];
  }

  // ── Hook-config writing (Copilot CLI shape) ────────────
  //
  // GitHub Copilot CLI's hooks schema differs from the VS Code / JetBrains
  // Copilot extensions that share CopilotBaseAdapter:
  //   - hook entries are FLAT `{ type: "command", command }` — NOT the
  //     Claude-Code nested `{ matcher, hooks: [...] }` shape the base emits, and
  //   - the file MUST carry a top-level `"version": 1` or the CLI runtime
  //     rejects it and the hooks never fire
  //     (docs.github.com/en/copilot/reference/hooks-configuration).
  // The shared base also hardcodes `mkdir .github/hooks` and writes there, but
  // this adapter's settings live at ~/.copilot/hooks/context-mode.json, so
  // writeSettings is overridden to create the real parent directory. All three
  // overrides are scoped to copilot-cli so vscode/jetbrains-copilot keep the
  // shared base behavior unchanged.

  generateHookConfig(pluginRoot: string): HookRegistration {
    const { HOOK_TYPES, buildHookCommand } = this.hookModule;
    const flat = (hookType: string) =>
      [
        { type: "command", command: buildHookCommand(hookType, pluginRoot) },
      ] as unknown as HookRegistration[string];
    // Emit an entry for every declared hook type (PreToolUse, PostToolUse,
    // PreCompact, SessionStart, UserPromptSubmit, Stop).
    const config: HookRegistration = {};
    for (const hookType of Object.values(HOOK_TYPES)) {
      config[hookType] = flat(hookType);
    }
    return config;
  }

  writeSettings(settings: Record<string, unknown>): void {
    const configPath = this.getSettingsPath();
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  }

  configureAllHooks(pluginRoot: string): string[] {
    const changes: string[] = [];
    const settings = this.readSettings() ?? {};
    const hooks =
      (settings.hooks as Record<string, unknown> | undefined) ?? {};
    const { HOOK_TYPES, HOOK_SCRIPTS, buildHookCommand } = this.hookModule;

    // Configure every hook type the module declares (PreToolUse, PostToolUse,
    // PreCompact, SessionStart, UserPromptSubmit, Stop) — driven by HOOK_TYPES
    // so new events are picked up automatically.
    for (const hookType of Object.values(HOOK_TYPES)) {
      if (!HOOK_SCRIPTS[hookType]) continue;
      const desired = [
        { type: "command", command: buildHookCommand(hookType, pluginRoot) },
      ];
      // Only treat a hook as drift when it differs from desired, so repeated
      // `context-mode upgrade` runs stay idempotent.
      if (JSON.stringify(hooks[hookType]) !== JSON.stringify(desired)) {
        hooks[hookType] = desired;
        changes.push(`Configured ${hookType} hook`);
      }
    }

    // Absence of the required top-level version is itself drift.
    if (settings.version !== 1) {
      changes.push("Set hooks schema version to 1");
    }

    if (changes.length > 0) {
      settings.version = 1;
      settings.hooks = hooks;
      this.writeSettings(settings);
      changes.push(`Wrote hook config to ${this.getSettingsPath()}`);
    }

    return changes;
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
        ...(config.version === 1 ? {} : { fix: "context-mode upgrade" }),
      });

      for (const hookName of [COPILOT_HOOK_NAMES.PRE_TOOL_USE, COPILOT_HOOK_NAMES.SESSION_START]) {
        const configured = Array.isArray(hooks?.[hookName]) && (hooks?.[hookName] as unknown[]).length > 0;
        results.push({
          check: `${hookName} hook`,
          status: configured ? "pass" : "fail",
          message: configured
            ? `${hookName} hook configured in ${this.getSettingsPath()}`
            : `${hookName} not found in ${this.getSettingsPath()}`,
          ...(configured ? {} : { fix: "context-mode upgrade" }),
        });
      }
    } catch {
      results.push({
        check: "Hook configuration",
        status: "fail",
        message: `Could not read ${this.getSettingsPath()}`,
        fix: "context-mode upgrade",
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
        // `context-mode upgrade` configures HOOKS only — never the MCP server.
        // Copilot CLI's own command writes ~/.copilot/mcp-config.json for us.
        fix: "copilot mcp add context-mode -- context-mode",
      };
    } catch {
      return {
        check: "MCP registration",
        status: "fail",
        message: `Could not read ${copilotCliMcpConfigPath()}`,
        fix: "copilot mcp add context-mode -- context-mode",
      };
    }
  }

  getInstalledVersion(): string {
    return existsSync(copilotCliMcpConfigPath()) || existsSync(this.getSettingsPath())
      ? "configured"
      : "not installed";
  }
}
