/**
 * adapters/detect — Auto-detect which platform is running.
 *
 * Detection priority:
 *   1. Environment variables (high confidence)
 *   2. Config directory existence (medium confidence)
 *   3. Fallback to Claude Code (low confidence — most common)
 *
 * Verified env vars per platform (from source code audit):
 *   - Claude Code:    CLAUDE_CODE_ENTRYPOINT, CLAUDE_PLUGIN_ROOT,
 *                     CLAUDE_PROJECT_DIR, CLAUDE_SESSION_ID | ~/.claude/
 *   - Gemini CLI:     GEMINI_PROJECT_DIR (hooks), GEMINI_CLI (MCP) | ~/.gemini/
 *   - KiloCode:       KILO, KILO_PID | ~/.config/kilo/
 *   - OpenCode:       OPENCODE_PROJECT_DIR, OPENCODE_CLIENT,
 *                     OPENCODE_TERMINAL, OPENCODE, OPENCODE_PID |
 *                     ~/.config/opencode/
 *   - OpenClaw:       OPENCLAW_HOME, OPENCLAW_CLI | ~/.openclaw/
 *   - Codex CLI:      CODEX_CI, CODEX_THREAD_ID | ~/.codex/
 *   - Cursor:         CURSOR_TRACE_ID (MCP), CURSOR_CLI (terminal) | ~/.cursor/
 *   - VS Code Copilot: VSCODE_PID, VSCODE_CWD | ~/.vscode/
 *   - JetBrains Copilot: IDEA_INITIAL_DIRECTORY, IDEA_HOME, JETBRAINS_CLIENT_ID | ~/.config/JetBrains/
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

import type { PlatformId, DetectionSignal, HookAdapter, PlatformEnvEntry } from "./types.js";
import { CLIENT_NAME_TO_PLATFORM } from "./client-map.js";
import { ADAPTER_REGISTRY, getRegistryEntry } from "./registry.js";

// Re-export so the existing public surface stays the same (used by
// src/util/project-dir.ts, hooks/, and external test files).
export type { EnvVarRole, PlatformEnvEntry } from "./types.js";

/**
 * Issue #539 — fallback disambiguator. When env-var detection would
 * otherwise resolve to vscode-copilot (because Microsoft's `code` exports
 * VSCODE_PID into every spawned child), we look at
 * ~/.claude/plugins/installed_plugins.json. If that file lists context-mode
 * as an installed plugin, the runtime MUST be Claude Code — VS Code Copilot
 * has no concept of Claude plugins. Memoized per-process: the file is read
 * at most once, with a tri-state cache so a missing/malformed file does not
 * trigger repeated I/O on the detect() hot path.
 */
type PluginCache = { hasCM: boolean } | "miss" | null;
let claudeCodePluginCache: PluginCache = null;

function claudeCodeHasContextModePlugin(): boolean {
  if (claudeCodePluginCache !== null) {
    return claudeCodePluginCache !== "miss" && claudeCodePluginCache.hasCM;
  }
  try {
    const path = resolve(homedir(), ".claude", "plugins", "installed_plugins.json");
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as {
      plugins?: Record<string, unknown>;
      enabledPlugins?: Record<string, unknown>;
    };
    const keys = [
      ...Object.keys(parsed.plugins ?? {}),
      ...Object.keys(parsed.enabledPlugins ?? {}),
    ];
    const hasCM = keys.some((k) => k.includes("context-mode"));
    claudeCodePluginCache = { hasCM };
    return hasCM;
  } catch {
    claudeCodePluginCache = "miss";
    return false;
  }
}

/** Test-only: reset the installed_plugins.json memo so each test starts cold. */
export function __resetClaudeCodePluginCacheForTests(): void {
  claudeCodePluginCache = null;
}

/**
 * Test-only: pretend installed_plugins.json does not exist (or has no
 * context-mode entry). Lets tests that exercise the genuine vscode-copilot
 * env-var path run on a developer machine that actually has context-mode
 * installed as a Claude Code plugin.
 */
export function __seedClaudeCodePluginCacheMissForTests(): void {
  claudeCodePluginCache = "miss";
}

/**
 * High-confidence env vars per platform, checked in priority order.
 *
 * Single source of truth — derived from `ADAPTER_REGISTRY` per Item D2 of
 * docs/setup-improvements.md. Order = registry order, which is the
 * detection precedence order (forks before parents). Empty arrays are
 * omitted from the map (openclaw, kiro fall through to the config-dir
 * tier below).
 *
 * Consumed by `detectPlatform()` below, by `resolveProjectDir({
 * strictPlatform })` for cascade construction, and by Pi's bridge env
 * scrub. Tests also iterate this map to clear platform-related env vars
 * deterministically.
 */
export const PLATFORM_ENV_VARS: ReadonlyMap<PlatformId, readonly PlatformEnvEntry[]> = new Map(
  ADAPTER_REGISTRY
    .filter((entry) => entry.envVars.length > 0)
    .map((entry) => [entry.id, entry.envVars] as const),
);

/**
 * Backwards-compat shim: legacy `string[]` shape used by detection logic and
 * by tests that iterate the registry to clear env vars. Always returns the
 * names in registry order.
 */
export function getEnvVarNames(platform: PlatformId): string[] {
  return (PLATFORM_ENV_VARS.get(platform) ?? []).map((e) => e.name);
}

/**
 * Issue #545 — return only role=workspace env var names for a platform, in
 * registry order. Empty array for adapters with no workspace var (e.g.
 * codex, kilo, zed, antigravity, openclaw, kiro). Consumed by
 * `resolveProjectDir({ strictPlatform })` to build the cascade.
 */
export function workspaceEnvVarsFor(platform: PlatformId): string[] {
  return (PLATFORM_ENV_VARS.get(platform) ?? [])
    .filter((e) => e.role === "workspace")
    .map((e) => e.name);
}

/**
 * Issue #545 — return the union of workspace env vars from ALL platforms
 * EXCEPT the given one. Consumed by Pi's bridge env scrub (strip foreign
 * workspace vars from spawned MCP child) and by the matrix regression test.
 */
export function foreignWorkspaceEnv(platform: PlatformId): Set<string> {
  const ban = new Set<string>();
  for (const [p, vars] of PLATFORM_ENV_VARS) {
    if (p === platform) continue;
    for (const v of vars) {
      if (v.role === "workspace") ban.add(v.name);
    }
  }
  return ban;
}

/**
 * Issue #561 — return the union of identification env vars from ALL
 * platforms EXCEPT the given one. Sibling of `foreignWorkspaceEnv`,
 * filtered on `role === "identification"` instead of "workspace".
 *
 * Consumed by Pi's bridge env scrub: when Pi spawns the context-mode
 * MCP child, the child inherits the host shell env including any
 * identification vars set by a co-resident Claude Code session
 * (CLAUDE_CODE_ENTRYPOINT / CLAUDE_PLUGIN_ROOT). Without scrubbing,
 * `detectPlatform()` in the child falls through env priority order and
 * resolves to claude-code first — Pi's session data then writes into
 * `~/.claude/context-mode/` instead of Pi's own dir. Scrubbing FOREIGN
 * identification vars (everyone else's) preserves Pi's OWN identification
 * vars (PI_CONFIG_DIR / PI_SESSION_FILE / PI_COMPILED) so the child still
 * detects pi correctly.
 *
 * Algorithmic, registry-driven — adding adapter #16 grows the scrub
 * automatically (no edit to mcp-bridge.ts).
 */
export function foreignIdentificationEnv(platform: PlatformId): Set<string> {
  const ban = new Set<string>();
  for (const [p, vars] of PLATFORM_ENV_VARS) {
    if (p === platform) continue;
    for (const v of vars) {
      if (v.role === "identification") ban.add(v.name);
    }
  }
  return ban;
}

/**
 * Sync map from platform identifier → home-relative path segments where that
 * platform stores its config. Used before an adapter has been instantiated
 * (race window between MCP server start and `initialize` handshake completion).
 *
 * Returns `null` for "unknown" or any string outside the supported set so the
 * caller can decide on a safe fallback. The mapping lives in
 * `adapters/registry.ts` — this function is a lookup wrapper.
 */
export function getSessionDirSegments(platform: string): string[] | null {
  const entry = getRegistryEntry(platform);
  return entry ? [...entry.sessionDirSegments] : null;
}

/**
 * Detect the current platform by checking env vars and config dirs.
 *
 * @param clientInfo - Optional MCP clientInfo from initialize handshake.
 *   When provided, takes highest priority (zero-config detection).
 */
export function detectPlatform(clientInfo?: { name: string; version?: string }): DetectionSignal {
  // ── Highest priority: MCP clientInfo ──────────────────
  if (clientInfo?.name) {
    const platform = CLIENT_NAME_TO_PLATFORM[clientInfo.name];
    if (platform) {
      return {
        platform,
        confidence: "high",
        reason: `MCP clientInfo.name="${clientInfo.name}"`,
      };
    }
    // Qwen Code uses dynamic client names: qwen-cli-mcp-client-<serverName>
    if (clientInfo.name.startsWith("qwen-cli-mcp-client")) {
      return {
        platform: "qwen-code",
        confidence: "high",
        reason: `MCP clientInfo.name="${clientInfo.name}" (qwen-cli pattern)`,
      };
    }
  }

  // ── Explicit platform override ────────────────────────
  const platformOverride = process.env.CONTEXT_MODE_PLATFORM;
  if (platformOverride) {
    const validPlatforms: PlatformId[] = [
      "claude-code", "gemini-cli", "kilo", "opencode", "codex",
      "vscode-copilot", "jetbrains-copilot", "cursor", "antigravity", "kiro", "pi", "omp", "zed", "qwen-code",
    ];
    if (validPlatforms.includes(platformOverride as PlatformId)) {
      return {
        platform: platformOverride as PlatformId,
        confidence: "high",
        reason: `CONTEXT_MODE_PLATFORM=${platformOverride} override`,
      };
    }
  }

  // ── High confidence: environment variables ─────────────

  for (const [platform, vars] of PLATFORM_ENV_VARS) {
    if (vars.some((v) => v.detect !== false && process.env[v.name])) {
      // Issue #539 belt-and-suspenders: VSCODE_PID/VSCODE_CWD are exported
      // by VS Code into EVERY child process — including a Claude Code CLI
      // launched from the integrated terminal. If env vars alone want to
      // resolve to vscode-copilot, but ~/.claude/plugins/installed_plugins.json
      // lists context-mode as a Claude Code plugin, the runtime must be
      // Claude Code (VS Code Copilot has no plugin concept). The env-var
      // tier above already handles the common case via CLAUDE_CODE_ENTRYPOINT
      // / CLAUDE_PLUGIN_ROOT; this branch covers MCP-server-only boots where
      // those vars have not propagated yet.
      if (platform === "vscode-copilot" && claudeCodeHasContextModePlugin()) {
        return {
          platform: "claude-code",
          confidence: "high",
          reason:
            "VSCODE_PID set but ~/.claude/plugins/installed_plugins.json lists context-mode (issue #539 fallback)",
        };
      }
      return {
        platform,
        confidence: "high",
        reason: `${vars.filter((v) => v.detect !== false).map((v) => v.name).join(" or ")} env var set`,
      };
    }
  }

  // ── Medium confidence: config directory existence ──────

  const home = homedir();

  if (existsSync(resolve(home, ".claude"))) {
    return {
      platform: "claude-code",
      confidence: "medium",
      reason: "~/.claude/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".gemini"))) {
    return {
      platform: "gemini-cli",
      confidence: "medium",
      reason: "~/.gemini/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".codex"))) {
    return {
      platform: "codex",
      confidence: "medium",
      reason: "~/.codex/ directory exists",
    };
  }

  // Issue #542 — CLI agents BEFORE host IDEs.
  //
  // Cursor (a VSCode fork) is the most installed editor across our user
  // base. Checking ~/.cursor/ first means every CLI agent co-installed
  // with Cursor (Pi, OMP, Kiro, Qwen) silently routes through
  // CursorAdapter even though the agent owns the session — Cursor merely
  // hosts the terminal. Reorder: agents (.kiro/.omp/.pi/.qwen/.openclaw)
  // win the medium-confidence tier, editors (~/.cursor/, ~/.vscode/,
  // JetBrains) lose. Verified by the detect-config-dir.test.ts matrix.
  if (existsSync(resolve(home, ".kiro"))) {
    return {
      platform: "kiro",
      confidence: "medium",
      reason: "~/.kiro/ directory exists",
    };
  }

  // OMP listed BEFORE pi: shared ~/.pi history with OMP-only ~/.omp/ marker.
  if (existsSync(resolve(home, ".omp"))) {
    return {
      platform: "omp",
      confidence: "medium",
      reason: "~/.omp/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".pi"))) {
    return {
      platform: "pi",
      confidence: "medium",
      reason: "~/.pi/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".qwen"))) {
    return {
      platform: "qwen-code",
      confidence: "medium",
      reason: "~/.qwen/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".openclaw"))) {
    return {
      platform: "openclaw",
      confidence: "medium",
      reason: "~/.openclaw/ directory exists",
    };
  }

  // Cursor / host IDEs — checked AFTER all CLI agents (issue #542).
  if (existsSync(resolve(home, ".cursor"))) {
    return {
      platform: "cursor",
      confidence: "medium",
      reason: "~/.cursor/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".config", "kilo"))) {
    return {
      platform: "kilo",
      confidence: "medium",
      reason: "~/.config/kilo/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".config", "JetBrains"))) {
    return {
      platform: "jetbrains-copilot",
      confidence: "medium",
      reason: "~/.config/JetBrains/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".config", "opencode"))) {
    return {
      platform: "opencode",
      confidence: "medium",
      reason: "~/.config/opencode/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".config", "zed"))) {
    return {
      platform: "zed",
      confidence: "medium",
      reason: "~/.config/zed/ directory exists",
    };
  }

  // ── Low confidence: fallback ───────────────────────────

  return {
    platform: "claude-code",
    confidence: "low",
    reason: "No platform detected, defaulting to Claude Code",
  };
}

/**
 * Get the adapter instance for a given platform.
 *
 * Looks the target up in `ADAPTER_REGISTRY` (single source of truth in
 * `adapters/registry.ts`). Unknown / "unknown" ids fall back to
 * ClaudeCodeAdapter so the MCP server still works on unsupported hosts.
 */
export async function getAdapter(platform?: PlatformId): Promise<HookAdapter> {
  const target = platform ?? detectPlatform().platform;
  const entry = getRegistryEntry(target);
  if (entry) return entry.load();
  // Unsupported platform — fall back to Claude Code adapter
  // (MCP server works everywhere, hooks may not).
  const { ClaudeCodeAdapter } = await import("./claude-code/index.js");
  return new ClaudeCodeAdapter();
}
