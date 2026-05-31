/**
 * adapters/gemini-cli — Gemini CLI platform adapter.
 *
 * Implements HookAdapter for Gemini CLI's JSON stdin/stdout hook paradigm.
 *
 * Gemini CLI hook specifics:
 *   - I/O: JSON on stdin, JSON on stdout (same paradigm as Claude Code)
 *   - Hook names: BeforeTool, AfterTool, PreCompress, SessionStart
 *   - Arg modification: `hookSpecificOutput.tool_input` (merged with original)
 *   - Blocking: `decision: "deny"` in response (NOT permissionDecision)
 *   - Output modification: `decision: "deny"` + reason replaces output,
 *     `hookSpecificOutput.additionalContext` appends
 *   - PreCompress: advisory only (async, cannot block)
 *   - No `decision: "ask"` support
 *   - Hooks don't fire for subagents yet
 *   - Config: ~/.gemini/settings.json (user), .gemini/settings.json (project)
 *   - Session ID: session_id field
 *   - Project dir env: GEMINI_PROJECT_DIR (also CLAUDE_PROJECT_DIR alias)
 *   - Session dir: ~/.gemini/context-mode/sessions/
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  accessSync,
  chmodSync,
  existsSync,
  constants,
} from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

import { BaseAdapter } from "../base.js";
import { parseJsonc } from "../../util/jsonc.js";

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
// Gemini CLI raw input types
// ─────────────────────────────────────────────────────────

interface GeminiCLIHookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  is_error?: boolean;
  session_id?: string;
  source?: string;
  cwd?: string;
}

// ─────────────────────────────────────────────────────────
// Hook constants (re-exported from hooks.ts)
// ─────────────────────────────────────────────────────────

import {
  HOOK_TYPES as GEMINI_HOOK_NAMES,
  HOOK_SCRIPTS as GEMINI_HOOK_SCRIPTS,
  buildHookCommand as buildGeminiHookCommand,
  isContextModeHook as isGeminiContextModeHook,
  EXTERNAL_MCP_MATCHER_PATTERN,
  type HookType as GeminiHookType,
} from "./hooks.js";

// ─────────────────────────────────────────────────────────
// Adapter implementation
// ─────────────────────────────────────────────────────────

export class GeminiCLIAdapter extends BaseAdapter implements HookAdapter {
  constructor() {
    super([".gemini"]);
  }

  readonly name = "Gemini CLI";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    preToolUse: true,
    postToolUse: true,
    preCompact: true,
    sessionStart: true,
    canModifyArgs: true,
    canModifyOutput: true,
    canInjectSessionContext: true,
  };

  // ── Input parsing ──────────────────────────────────────

  parsePreToolUseInput(raw: unknown): PreToolUseEvent {
    const input = raw as GeminiCLIHookInput;
    return {
      toolName: input.tool_name ?? "",
      toolInput: input.tool_input ?? {},
      sessionId: this.extractSessionId(input),
      projectDir: this.getProjectDir(input),
      raw,
    };
  }

  parsePostToolUseInput(raw: unknown): PostToolUseEvent {
    const input = raw as GeminiCLIHookInput;
    return {
      toolName: input.tool_name ?? "",
      toolInput: input.tool_input ?? {},
      toolOutput: input.tool_output,
      isError: input.is_error,
      sessionId: this.extractSessionId(input),
      projectDir: this.getProjectDir(input),
      raw,
    };
  }

  parsePreCompactInput(raw: unknown): PreCompactEvent {
    const input = raw as GeminiCLIHookInput;
    return {
      sessionId: this.extractSessionId(input),
      projectDir: this.getProjectDir(input),
      raw,
    };
  }

  parseSessionStartInput(raw: unknown): SessionStartEvent {
    const input = raw as GeminiCLIHookInput;
    const rawSource = input.source ?? "startup";

    let source: SessionStartEvent["source"];
    switch (rawSource) {
      case "compact":
        source = "compact";
        break;
      case "resume":
        source = "resume";
        break;
      case "clear":
        source = "clear";
        break;
      default:
        source = "startup";
    }

    return {
      sessionId: this.extractSessionId(input),
      source,
      projectDir: this.getProjectDir(input),
      raw,
    };
  }

  // ── Response formatting ────────────────────────────────

  formatPreToolUseResponse(response: PreToolUseResponse): unknown {
    if (response.decision === "deny") {
      return {
        decision: "deny",
        reason: response.reason ?? "Blocked by context-mode hook",
      };
    }
    if (response.decision === "modify" && response.updatedInput) {
      return {
        hookSpecificOutput: {
          tool_input: response.updatedInput,
        },
      };
    }
    if (response.decision === "context" && response.additionalContext) {
      // Gemini CLI: inject additionalContext via hookSpecificOutput
      return {
        hookSpecificOutput: {
          additionalContext: response.additionalContext,
        },
      };
    }
    if (response.decision === "ask") {
      // Gemini CLI: no native "ask" — deny to be safe
      return {
        decision: "deny",
        reason: response.reason ?? "Action requires user confirmation (security policy)",
      };
    }
    // "allow" — return undefined for passthrough
    return undefined;
  }

  formatPostToolUseResponse(response: PostToolUseResponse): unknown {
    if (response.updatedOutput) {
      // Gemini CLI: decision "deny" + reason replaces output
      return {
        decision: "deny",
        reason: response.updatedOutput,
      };
    }
    if (response.additionalContext) {
      return {
        hookSpecificOutput: {
          additionalContext: response.additionalContext,
        },
      };
    }
    return undefined;
  }

  formatPreCompactResponse(response: PreCompactResponse): unknown {
    // PreCompress is advisory only (async), but we can still return context
    return response.context ?? "";
  }

  formatSessionStartResponse(response: SessionStartResponse): unknown {
    return response.context ?? "";
  }

  // ── Configuration ──────────────────────────────────────

  getSettingsPath(): string {
    return resolve(homedir(), ".gemini", "settings.json");
  }

  getInstructionFiles(): string[] {
    return ["GEMINI.md"];
  }

  generateHookConfig(pluginRoot: string): HookRegistration {
    return {
      [GEMINI_HOOK_NAMES.BEFORE_AGENT]: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildGeminiHookCommand(GEMINI_HOOK_NAMES.BEFORE_AGENT, pluginRoot),
            },
          ],
        },
      ],
      [GEMINI_HOOK_NAMES.BEFORE_TOOL]: [
        {
          // Gemini native tools + context-mode own MCP (both canonical and Claude
          // shim prefixes) + external MCP catch-all (#529).
          matcher: `run_shell_command|read_file|read_many_files|grep_search|search_file_content|web_fetch|activate_skill|mcp__plugin_context-mode|mcp__context-mode|${EXTERNAL_MCP_MATCHER_PATTERN}`,
          hooks: [
            {
              type: "command",
              command: buildGeminiHookCommand(GEMINI_HOOK_NAMES.BEFORE_TOOL, pluginRoot),
            },
          ],
        },
      ],
      [GEMINI_HOOK_NAMES.AFTER_TOOL]: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildGeminiHookCommand(GEMINI_HOOK_NAMES.AFTER_TOOL, pluginRoot),
            },
          ],
        },
      ],
      [GEMINI_HOOK_NAMES.PRE_COMPRESS]: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildGeminiHookCommand(GEMINI_HOOK_NAMES.PRE_COMPRESS, pluginRoot),
            },
          ],
        },
      ],
      [GEMINI_HOOK_NAMES.SESSION_START]: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildGeminiHookCommand(GEMINI_HOOK_NAMES.SESSION_START, pluginRoot),
            },
          ],
        },
      ],
    };
  }

  readSettings(): Record<string, unknown> | null {
    // ~/.gemini/settings.json is JSONC (Gemini CLI parses it with
    // strip-json-comments) — parse tolerantly so doctor agrees with setup's
    // JSONC-tolerant write path. (Loop-4 consistency fix.)
    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      return parseJsonc<Record<string, unknown>>(raw) ?? null;
    } catch {
      return null;
    }
  }

  writeSettings(settings: Record<string, unknown>): void {
    const dir = resolve(homedir(), ".gemini");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      this.getSettingsPath(),
      JSON.stringify(settings, null, 2) + "\n",
      "utf-8",
    );
  }

  // ── Diagnostics (doctor) ─────────────────────────────────

  validateHooks(pluginRoot: string): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];
    const settings = this.readSettings();

    if (!settings) {
      results.push({
        check: "BeforeTool hook",
        status: "fail",
        message: "Could not read ~/.gemini/settings.json",
        fix: "context-mode upgrade",
      });
      return results;
    }

    const hooks = settings.hooks as Record<string, unknown[]> | undefined;

    // Check BeforeTool
    const beforeTool = hooks?.[GEMINI_HOOK_NAMES.BEFORE_TOOL] as
      | Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>
      | undefined;
    if (beforeTool && beforeTool.length > 0) {
      const hasHook = beforeTool.some((entry) =>
        entry.hooks?.some((h) => h.command?.includes("context-mode")),
      );
      results.push({
        check: "BeforeTool hook",
        status: hasHook ? "pass" : "fail",
        message: hasHook
          ? "BeforeTool hook configured"
          : "BeforeTool exists but does not point to context-mode",
        fix: hasHook ? undefined : "context-mode upgrade",
      });
    } else {
      results.push({
        check: "BeforeTool hook",
        status: "fail",
        message: "No BeforeTool hooks found",
        fix: "context-mode upgrade",
      });
    }

    // Check SessionStart
    const sessionStart = hooks?.[GEMINI_HOOK_NAMES.SESSION_START] as
      | Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>
      | undefined;
    if (sessionStart && sessionStart.length > 0) {
      const hasHook = sessionStart.some((entry) =>
        entry.hooks?.some((h) => h.command?.includes("context-mode")),
      );
      results.push({
        check: "SessionStart hook",
        status: hasHook ? "pass" : "fail",
        message: hasHook
          ? "SessionStart hook configured"
          : "SessionStart exists but does not point to context-mode",
        fix: hasHook ? undefined : "context-mode upgrade",
      });
    } else {
      results.push({
        check: "SessionStart hook",
        status: "fail",
        message: "No SessionStart hooks found",
        fix: "context-mode upgrade",
      });
    }

    return results;
  }

  checkPluginRegistration(): DiagnosticResult {
    const settings = this.readSettings();
    if (!settings) {
      return {
        check: "Plugin registration",
        status: "warn",
        message: "Could not read ~/.gemini/settings.json",
      };
    }

    // `context-mode setup` (and `upgrade`) register the MCP server under
    // `mcpServers` in ~/.gemini/settings.json — check that FIRST so doctor
    // agrees with what setup writes (otherwise setup succeeds but doctor
    // WARNs "not found in extensions"). The `extensions` check below covers
    // the Gemini extension-marketplace install path.
    const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
    if (mcpServers && Object.keys(mcpServers).some((k) => k.includes("context-mode"))) {
      return {
        check: "Plugin registration",
        status: "pass",
        message: "context-mode found in mcpServers (~/.gemini/settings.json)",
      };
    }

    // Check extensions (Gemini extension-marketplace install path).
    const extensions = settings.extensions as
      | Record<string, unknown>
      | Array<unknown>
      | undefined;

    if (extensions) {
      const hasPlugin = Array.isArray(extensions)
        ? extensions.some(
            (e) =>
              typeof e === "string" && e.includes("context-mode"),
          )
        : Object.keys(extensions).some((k) => k.includes("context-mode"));

      if (hasPlugin) {
        return {
          check: "Plugin registration",
          status: "pass",
          message: "context-mode found in extensions",
        };
      }
    }

    return {
      check: "Plugin registration",
      status: "warn",
      message: "context-mode not found in mcpServers or extensions — run `context-mode setup`",
    };
  }

  getInstalledVersion(): string {
    // Check ~/.gemini/ extension cache for context-mode
    try {
      const cachePath = resolve(
        homedir(),
        ".gemini",
        "extensions",
        "context-mode",
        "package.json",
      );
      const pkg = JSON.parse(readFileSync(cachePath, "utf-8"));
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      /* not found */
    }
    return "not installed";
  }

  // ── Upgrade ────────────────────────────────────────────

  configureAllHooks(pluginRoot: string): string[] {
    const settings = this.readSettings() ?? {};
    const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
    const changes: string[] = [];

    const hookConfigs: Array<{
      name: string;
    }> = [
      { name: GEMINI_HOOK_NAMES.BEFORE_AGENT },
      { name: GEMINI_HOOK_NAMES.BEFORE_TOOL },
      { name: GEMINI_HOOK_NAMES.SESSION_START },
    ];

    for (const config of hookConfigs) {
      const command = buildGeminiHookCommand(config.name as GeminiHookType, pluginRoot);
      const entry = {
        matcher: "",
        hooks: [{ type: "command", command }],
      };

      const existing = hooks[config.name] as
        | Array<Record<string, unknown>>
        | undefined;
      if (existing && Array.isArray(existing)) {
        // Use isContextModeHook (matches BOTH the path form
        // `node "<root>/hooks/x.mjs"` AND the CLI-dispatcher form
        // `context-mode hook gemini-cli x`). The previous naive
        // `includes("context-mode")` predicate never matched the path
        // form, so configureAllHooks appended a duplicate on every run
        // in the normal plugin-install mode and the DI-1 write-skip guard
        // was dead code there. (Second-pass workflow finding.)
        const idx = existing.findIndex((e) =>
          isGeminiContextModeHook(
            e as { hooks?: Array<{ command?: string }> },
            config.name as GeminiHookType,
          ),
        );
        if (idx >= 0) {
          // Item DI-1 — only report "Updated existing..." when the entry
          // actually differs from desired. Without this guard, every
          // configureAllHooks call (including those triggered by setup
          // --check) reports a phantom change even when state is correct.
          if (JSON.stringify(existing[idx]) !== JSON.stringify(entry)) {
            existing[idx] = entry;
            changes.push(`Updated existing ${config.name} hook entry`);
          }
        } else {
          existing.push(entry);
          changes.push(`Added ${config.name} hook entry`);
        }
        hooks[config.name] = existing;
      } else {
        hooks[config.name] = [entry];
        changes.push(`Created ${config.name} hooks section`);
      }
    }

    // DI-1 — skip write when nothing changed. The previous behavior
    // re-wrote settings.json on every call even when bytes were
    // identical, churning mtimes and triggering watchers.
    if (changes.length > 0) {
      settings.hooks = hooks;
      this.writeSettings(settings);
    }
    return changes;
  }

  setHookPermissions(pluginRoot: string): string[] {
    const set: string[] = [];
    const hooksDir = join(pluginRoot, "hooks", "gemini-cli");
    for (const scriptName of Object.values(GEMINI_HOOK_SCRIPTS)) {
      const scriptPath = resolve(hooksDir, scriptName);
      try {
        accessSync(scriptPath, constants.R_OK);
        chmodSync(scriptPath, 0o755);
        set.push(scriptPath);
      } catch {
        /* skip missing scripts */
      }
    }
    return set;
  }

  updatePluginRegistry(pluginRoot: string, version: string): void {
    // Gemini CLI doesn't have a formal plugin registry like Claude Code.
    // Update the extension cache package.json if it exists.
    try {
      const pkgPath = resolve(
        homedir(),
        ".gemini",
        "extensions",
        "context-mode",
        "package.json",
      );
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      pkg.version = version;
      pkg.installPath = pluginRoot;
      pkg.lastUpdated = new Date().toISOString();
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
    } catch {
      /* best effort */
    }
  }

  // ── Internal helpers ───────────────────────────────────

  /**
   * Resolve the project directory for a Gemini CLI hook input.
   * Priority: input.cwd > GEMINI_PROJECT_DIR > CLAUDE_PROJECT_DIR > process.cwd().
   * Mirrors the cursor / opencode pattern so downstream hooks always
   * receive a defined projectDir even when the platform omits cwd
   * from the wire payload (e.g. under worktrees).
   */
  private getProjectDir(input: GeminiCLIHookInput): string {
    return (
      input.cwd
      ?? process.env.GEMINI_PROJECT_DIR
      ?? process.env.CLAUDE_PROJECT_DIR
      ?? process.cwd()
    );
  }

  /**
   * Extract session ID from Gemini CLI hook input.
   * Priority: session_id field > env fallback > ppid fallback.
   */
  private extractSessionId(input: GeminiCLIHookInput): string {
    if (input.session_id) return input.session_id;
    return `pid-${process.ppid}`;
  }
}
