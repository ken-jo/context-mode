/**
 * adapters/openclaw — OpenClaw platform adapter.
 *
 * Implements HookAdapter for OpenClaw's TypeScript plugin paradigm.
 *
 * OpenClaw hook specifics:
 *   - I/O: TS plugin functions via api.registerHook() and api.on()
 *   - Hook events: tool_call:before, tool_call:after, command:new
 *   - Lifecycle: before_prompt_build (routing instruction injection)
 *   - Context engine: api.registerContextEngine() with ownsCompaction
 *   - Arg modification: mutate event.params in tool_call:before
 *   - Blocking: return { block: true, blockReason } from tool_call:before
 *   - Session ID: event context (no specific env var)
 *   - Project dir: process.cwd()
 *   - Config: openclaw.json plugins.entries, ~/.openclaw/extensions/
 *   - Session dir: ~/.openclaw/context-mode/sessions/
 */

import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  accessSync,
  mkdirSync,
  constants,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";

import { BaseAdapter } from "../base.js";
import { parseJsonc } from "../../util/jsonc.js";

/**
 * Resolve the openclaw.json the GATEWAY actually loads, mirroring
 * scripts/install-openclaw-plugin.sh + the gateway docs: $OPENCLAW_CONFIG_PATH,
 * else $OPENCLAW_STATE_DIR/openclaw.json, else ~/.openclaw/openclaw.json. The
 * gateway NEVER loads a CWD/project-local openclaw.json (it only reads a CWD
 * .env), so the old `resolve("openclaw.json")` (process.cwd()) dropped the file
 * where nothing reads it — setup reported success but context-mode never
 * loaded. (Loop-5 official-source workflow finding.)
 */
export function openclawConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCLAW_CONFIG_PATH) return resolve(env.OPENCLAW_CONFIG_PATH);
  const stateDir = env.OPENCLAW_STATE_DIR
    ? resolve(env.OPENCLAW_STATE_DIR)
    : resolve(homedir(), ".openclaw");
  return resolve(stateDir, "openclaw.json");
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
// OpenClaw raw input types
// ─────────────────────────────────────────────────────────

interface OpenClawHookInput {
  toolName?: string;
  tool_name?: string;
  params?: Record<string, unknown>;
  tool_input?: Record<string, unknown>;
  output?: string;
  tool_output?: string;
  isError?: boolean;
  is_error?: boolean;
  sessionId?: string;
  source?: string;
  cwd?: string;
}

// ─────────────────────────────────────────────────────────
// Hook constants (re-exported from hooks.ts)
// ─────────────────────────────────────────────────────────

import { HOOK_EVENTS as OPENCLAW_HOOK_EVENTS } from "./hooks.js";

// ─────────────────────────────────────────────────────────
// Adapter implementation
// ─────────────────────────────────────────────────────────

export class OpenClawAdapter extends BaseAdapter implements HookAdapter {
  constructor() {
    super([".openclaw"]);
  }

  readonly name = "OpenClaw";
  readonly paradigm: HookParadigm = "ts-plugin";

  readonly capabilities: PlatformCapabilities = {
    preToolUse: true,
    postToolUse: true,
    preCompact: true, // via registerContextEngine with ownsCompaction
    sessionStart: true, // via command:new hook
    canModifyArgs: true,
    canModifyOutput: false,
    canInjectSessionContext: true, // via before_prompt_build lifecycle hook
  };

  // ── Input parsing ──────────────────────────────────────

  parsePreToolUseInput(raw: unknown): PreToolUseEvent {
    const input = raw as OpenClawHookInput;
    return {
      toolName: input.toolName ?? input.tool_name ?? "",
      toolInput: input.params ?? input.tool_input ?? {},
      sessionId: this.extractSessionId(input),
      projectDir: this.getProjectDir(input),
      raw,
    };
  }

  parsePostToolUseInput(raw: unknown): PostToolUseEvent {
    const input = raw as OpenClawHookInput;
    return {
      toolName: input.toolName ?? input.tool_name ?? "",
      toolInput: input.params ?? input.tool_input ?? {},
      toolOutput: input.output ?? input.tool_output,
      isError: input.isError ?? input.is_error,
      sessionId: this.extractSessionId(input),
      projectDir: this.getProjectDir(input),
      raw,
    };
  }

  parsePreCompactInput(raw: unknown): PreCompactEvent {
    const input = raw as OpenClawHookInput;
    return {
      sessionId: this.extractSessionId(input),
      projectDir: this.getProjectDir(input),
      raw,
    };
  }

  parseSessionStartInput(raw: unknown): SessionStartEvent {
    const input = raw as OpenClawHookInput;
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
      // OpenClaw plugin paradigm: return { block, blockReason } to block
      return {
        block: true,
        blockReason: response.reason ?? "Blocked by context-mode hook",
      };
    }
    if (response.decision === "modify" && response.updatedInput) {
      // OpenClaw: mutate params in the event object
      return { params: response.updatedInput };
    }
    if (response.decision === "ask") {
      // OpenClaw: block for safety when user confirmation needed
      return {
        block: true,
        blockReason: response.reason ?? "Action requires user confirmation (security policy)",
      };
    }
    if (response.decision === "context" && response.additionalContext) {
      // OpenClaw supports context injection via before_prompt_build,
      // but not inline in tool_call:before. Passthrough.
      return undefined;
    }
    // "allow" — passthrough
    return undefined;
  }

  formatPostToolUseResponse(response: PostToolUseResponse): unknown {
    const result: Record<string, unknown> = {};
    if (response.additionalContext) {
      result.additionalContext = response.additionalContext;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  formatPreCompactResponse(response: PreCompactResponse): unknown {
    // Context engine compact() returns { ok, compacted } — context is managed internally
    return response.context ?? "";
  }

  formatSessionStartResponse(response: SessionStartResponse): unknown {
    return response.context ?? "";
  }

  // ── Configuration ──────────────────────────────────────

  getSettingsPath(): string {
    // The single file the gateway loads (env / state-dir / ~/.openclaw),
    // NOT process.cwd() — so setup writes and doctor reads where OpenClaw reads.
    return openclawConfigPath();
  }

  /**
   * OpenClaw stores everything in the project root — no separate config
   * dir. Returned as the absolute project directory itself per the
   * HookAdapter.getConfigDir contract (always-absolute).
   */
  getConfigDir(projectDir?: string): string {
    return resolve(projectDir ?? process.cwd());
  }

  getInstructionFiles(): string[] {
    return ["AGENTS.md"];
  }

  /**
   * Absolute <projectRoot>/memory directory.
   *
   * OpenClaw's `getConfigDir(projectDir)` already returns the project root,
   * so the memory dir is naturally project-scoped per the OpenClaw
   * convention. The `projectDir` parameter is honored for explicit
   * resolution; without it, falls back to the implicit `process.cwd()`
   * inside `getConfigDir`. Either way, two projects never share a path
   * — no hash suffix needed (issue #663).
   */
  getMemoryDir(projectDir?: string): string {
    return join(this.getConfigDir(projectDir), "memory");
  }

  generateHookConfig(_pluginRoot: string): HookRegistration {
    // OpenClaw uses TS plugin paradigm — hooks are registered via
    // api.registerHook() in the plugin entry point, not via config files.
    // Return the hook name mapping for documentation purposes.
    return {
      [OPENCLAW_HOOK_EVENTS.TOOL_CALL_BEFORE]: [
        {
          matcher: "",
          hooks: [
            {
              type: "plugin",
              command: "context-mode",
            },
          ],
        },
      ],
      [OPENCLAW_HOOK_EVENTS.TOOL_CALL_AFTER]: [
        {
          matcher: "",
          hooks: [
            {
              type: "plugin",
              command: "context-mode",
            },
          ],
        },
      ],
      [OPENCLAW_HOOK_EVENTS.COMMAND_NEW]: [
        {
          matcher: "",
          hooks: [
            {
              type: "plugin",
              command: "context-mode",
            },
          ],
        },
      ],
    };
  }

  readSettings(): Record<string, unknown> | null {
    // Read the gateway's real config FIRST (env / state-dir / ~/.openclaw),
    // then fall back to project-local files only as a last resort. Keeping the
    // canonical path first means doctor validates the same file setup wrote and
    // the gateway loads (was CWD-first, which masked the wrong-location bug).
    const paths = [...new Set([
      openclawConfigPath(),
      resolve("openclaw.json"),
      resolve(".openclaw", "openclaw.json"),
      join(homedir(), ".openclaw", "openclaw.json"),
    ])];
    for (const configPath of paths) {
      let raw: string;
      try {
        raw = readFileSync(configPath, "utf-8");
      } catch {
        continue; // file not present at this path — try the next
      }
      // OpenClaw's config is officially JSON5 ("comments + trailing commas
      // allowed" — docs.openclaw.ai/gateway/configuration-reference), so a
      // strict JSON.parse false-fails a perfectly valid commented file and
      // makes `doctor` report "Could not read openclaw.json" even though the
      // gateway loads it fine. Use the JSONC-tolerant parse (same fix already
      // applied to the zed adapter + setup.ts readJsonForMerge). (Loop-2.)
      const parsed = parseJsonc<Record<string, unknown>>(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
      // Found the file but it failed even the tolerant parse — stop here
      // rather than falling through to a lower-priority path that would
      // mask a genuinely broken config at the file the gateway actually uses.
      return null;
    }
    return null;
  }

  writeSettings(settings: Record<string, unknown>): void {
    // Write to the file the gateway actually loads (env / state-dir /
    // ~/.openclaw), NOT process.cwd() — otherwise the gateway never sees it.
    const configPath = openclawConfigPath();
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify(settings, null, 2) + "\n",
      "utf-8",
    );
  }

  // ── Diagnostics (doctor) ─────────────────────────────────

  validateHooks(_pluginRoot: string): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];
    const settings = this.readSettings();

    if (!settings) {
      results.push({
        check: "Plugin configuration",
        status: "fail",
        message: "Could not read openclaw.json",
        fix: "context-mode setup openclaw",
      });
      return results;
    }

    // Check for context-mode in plugins.entries
    const plugins = settings.plugins as Record<string, unknown> | undefined;
    const entries = plugins?.entries as Record<string, unknown> | undefined;

    if (entries) {
      const hasPlugin = Object.keys(entries).some((k) => k.includes("context-mode"));
      results.push({
        check: "Plugin registration",
        status: hasPlugin ? "pass" : "fail",
        message: hasPlugin
          ? "context-mode found in plugins.entries"
          : "context-mode not found in plugins.entries",
        fix: hasPlugin
          ? undefined
          : "context-mode setup openclaw",
      });

      // Check if enabled
      if (hasPlugin) {
        const entry = entries["context-mode"] as Record<string, unknown> | undefined;
        const isEnabled = entry?.enabled !== false;
        results.push({
          check: "Plugin enabled",
          status: isEnabled ? "pass" : "warn",
          message: isEnabled
            ? "context-mode plugin is enabled"
            : "context-mode plugin is disabled",
        });
      }
    } else {
      results.push({
        check: "Plugin registration",
        status: "fail",
        message: "No plugins.entries found in openclaw.json",
        fix: "context-mode setup openclaw",
      });
    }

    // Check context engine slot
    const slots = plugins?.slots as Record<string, unknown> | undefined;
    if (slots?.contextEngine === "context-mode") {
      results.push({
        check: "Context engine",
        status: "pass",
        message: "context-mode registered as context engine (owns compaction)",
      });
    } else {
      results.push({
        check: "Context engine",
        status: "warn",
        message:
          "context-mode not set as context engine — compaction will use default engine",
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
        message: "Could not read openclaw.json",
      };
    }

    const plugins = settings.plugins as Record<string, unknown> | undefined;
    const entries = plugins?.entries as Record<string, unknown> | undefined;
    const inEntries =
      !!entries && Object.keys(entries).some((k) => k.includes("context-mode"));

    // The plugin only delivers ctx_* tools when the MCP sidecar is also
    // registered under mcp.servers — a plugins.entries-only config loads the
    // plugin but surfaces no tools. Require BOTH so doctor doesn't green-light
    // a tool-less install. (Loop-2 finding.)
    const mcp = settings.mcp as Record<string, unknown> | undefined;
    const mcpServers = mcp?.servers as Record<string, unknown> | undefined;
    const inMcp =
      !!mcpServers && Object.keys(mcpServers).some((k) => k.includes("context-mode"));

    if (inEntries && inMcp) {
      return {
        check: "Plugin registration",
        status: "pass",
        message: "context-mode found in plugins.entries + mcp.servers",
      };
    }
    if (inEntries && !inMcp) {
      return {
        check: "Plugin registration",
        status: "fail",
        message:
          "context-mode in plugins.entries but missing from mcp.servers — plugin loads but no ctx_* tools reach the agent",
        fix: "context-mode setup openclaw",
      };
    }
    return {
      check: "Plugin registration",
      status: "fail",
      message: "context-mode not found in openclaw.json plugins.entries",
      fix: "context-mode setup openclaw",
    };
  }

  getInstalledVersion(): string {
    // Check ~/.openclaw/extensions/context-mode/ for the plugin
    try {
      const pkgPath = resolve(
        homedir(),
        ".openclaw",
        "extensions",
        "context-mode",
        "package.json",
      );
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      /* not found */
    }

    // Also check node_modules
    try {
      const pkgPath = resolve(
        "node_modules",
        "context-mode",
        "package.json",
      );
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      /* not found */
    }

    return "not installed";
  }

  // ── Upgrade ────────────────────────────────────────────

  configureAllHooks(pluginRoot: string): string[] {
    const settings = this.readSettings() ?? {};
    const changes: string[] = [];

    // Ensure plugins.entries exists
    if (!settings.plugins) {
      settings.plugins = {};
    }
    const plugins = settings.plugins as Record<string, unknown>;

    if (!plugins.entries) {
      plugins.entries = {};
    }
    const entries = plugins.entries as Record<string, unknown>;

    // Add context-mode to plugins.entries
    if (!entries["context-mode"]) {
      entries["context-mode"] = { enabled: true };
      changes.push("Added context-mode to plugins.entries");
    } else {
      const entry = entries["context-mode"] as Record<string, unknown>;
      if (entry.enabled === false) {
        entry.enabled = true;
        changes.push("Enabled context-mode plugin");
      }
    }

    // plugins.allow — mirror register-openclaw-config.mjs so the gateway
    // actually permits the plugin to load (idempotent unshift).
    if (!Array.isArray(plugins.allow)) plugins.allow = [];
    const allow = plugins.allow as string[];
    if (!allow.includes("context-mode")) {
      allow.unshift("context-mode");
      changes.push("Added context-mode to plugins.allow");
    }

    // Optionally set context engine slot
    if (!plugins.slots) {
      plugins.slots = {};
    }
    const slots = plugins.slots as Record<string, unknown>;
    if (!slots.contextEngine) {
      slots.contextEngine = "context-mode";
      changes.push("Set context-mode as context engine (owns compaction)");
    }

    // Register the MCP sidecar — WITHOUT this, OpenClaw loads the plugin but
    // its ctx_* tools never reach the agent's tool list (confirmed against
    // OpenClaw 2026.4.22; see scripts/lib/register-openclaw-config.mjs). The
    // upgrade path previously omitted this, so `context-mode upgrade` produced
    // a hook-only config with zero callable tools that doctor green-lit.
    // (Loop-2 finding.) Mirror the installer's exact `${pluginRoot}/server.bundle.mjs`
    // form so install + upgrade stay byte-identical (idempotent).
    if (!settings.mcp || typeof settings.mcp !== "object") settings.mcp = {};
    const mcp = settings.mcp as Record<string, unknown>;
    if (!mcp.servers || typeof mcp.servers !== "object") mcp.servers = {};
    const servers = mcp.servers as Record<string, unknown>;
    const serverBundle = `${pluginRoot}/server.bundle.mjs`;
    const existing = servers["context-mode"] as Record<string, unknown> | undefined;
    const needsWrite =
      !existing ||
      existing.command !== "node" ||
      !Array.isArray(existing.args) ||
      (existing.args as unknown[])[0] !== serverBundle;
    if (needsWrite) {
      // Preserve user-added fields (env/cwd/timeout); own only command+args.
      const base = existing && typeof existing === "object" ? existing : {};
      servers["context-mode"] = { ...base, command: "node", args: [serverBundle] };
      changes.push(`Registered mcp.servers.context-mode → ${serverBundle}`);
    }

    if (changes.length > 0) {
      this.writeSettings(settings);
    }
    return changes;
  }

  /**
   * Inverse of configureAllHooks — remove the four keys context-mode registers
   * (plugins.entries, plugins.allow, plugins.slots.contextEngine, and
   * mcp.servers.context-mode) so `setup --uninstall` fully de-registers from
   * the gateway config. Resets the contextEngine slot only when it points at
   * context-mode. Preserves all sibling entries/servers.
   */
  unconfigureHooks(_pluginRoot: string): string[] {
    const settings = this.readSettings();
    if (!settings) return [];
    const changes: string[] = [];
    const plugins = settings.plugins as Record<string, unknown> | undefined;
    if (plugins && typeof plugins === "object") {
      const entries = plugins.entries as Record<string, unknown> | undefined;
      if (entries && "context-mode" in entries) {
        delete entries["context-mode"];
        changes.push("Removed context-mode from plugins.entries");
      }
      if (Array.isArray(plugins.allow)) {
        const before = plugins.allow as unknown[];
        const after = before.filter((p) => p !== "context-mode");
        if (after.length !== before.length) {
          plugins.allow = after;
          changes.push("Removed context-mode from plugins.allow");
        }
      }
      const slots = plugins.slots as Record<string, unknown> | undefined;
      if (slots && slots.contextEngine === "context-mode") {
        delete slots.contextEngine;
        changes.push("Cleared context-mode context engine slot");
      }
    }
    const mcp = settings.mcp as Record<string, unknown> | undefined;
    if (mcp && typeof mcp === "object") {
      const servers = mcp.servers as Record<string, unknown> | undefined;
      if (servers && "context-mode" in servers) {
        delete servers["context-mode"];
        changes.push("Removed context-mode from mcp.servers");
      }
    }
    if (changes.length > 0) this.writeSettings(settings);
    return changes;
  }

  backupSettings(): string | null {
    const paths = [
      openclawConfigPath(),
      resolve("openclaw.json"),
      resolve(".openclaw", "openclaw.json"),
      join(homedir(), ".openclaw", "openclaw.json"),
    ];
    for (const configPath of paths) {
      try {
        accessSync(configPath, constants.R_OK);
        const backupPath = configPath + ".bak";
        copyFileSync(configPath, backupPath);
        return backupPath;
      } catch {
        continue;
      }
    }
    return null;
  }

  setHookPermissions(_pluginRoot: string): string[] {
    // OpenClaw uses TS plugin paradigm — no shell scripts to chmod
    return [];
  }

  updatePluginRegistry(_pluginRoot: string, _version: string): void {
    // OpenClaw manages plugins through npm/openclaw.json — no separate registry
  }

  // ── Internal helpers ───────────────────────────────────

  /**
   * Resolve the project directory for an OpenClaw hook input.
   * Priority: input.cwd > OPENCLAW_PROJECT_DIR env > process.cwd().
   * Mirrors the cursor / opencode pattern so downstream hooks always
   * receive a defined projectDir even under worktrees or when the
   * platform omits cwd from the wire payload.
   */
  private getProjectDir(input: OpenClawHookInput): string {
    return input.cwd ?? process.env.OPENCLAW_PROJECT_DIR ?? process.cwd();
  }

  /**
   * Extract session ID from OpenClaw hook input.
   */
  private extractSessionId(input: OpenClawHookInput): string {
    if (input.sessionId) return input.sessionId;
    return `pid-${process.ppid}`;
  }
}
