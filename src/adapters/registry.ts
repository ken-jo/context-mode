/**
 * adapters/registry — single source of truth for the 15 supported platforms.
 *
 * Before this module the same platform set was redeclared in FOUR places:
 *   - `_PLATFORM_ENV_VARS_RAW` in detect.ts        (env-var detection)
 *   - `getSessionDirSegments` in detect.ts          (sync session-dir lookup)
 *   - `getAdapter` in detect.ts                     (lazy adapter loader)
 *   - per-adapter `super([...])` calls              (session-dir base class)
 *
 * Adding adapter #16 required editing all of them; missing one was silent
 * (cf. issue #473 follow-up for `pi`). Items D1 + D2 of
 * docs/setup-improvements.md collapse the first three into this module:
 * each adapter is declared once below with `{ id, sessionDirSegments,
 * envVars, load }`. detect.ts derives PLATFORM_ENV_VARS, getSessionDirSegments
 * and getAdapter from this list. The matrix test in
 * `tests/adapters/registry.test.ts` asserts every directory under
 * `src/adapters/<id>/` has a matching registry entry.
 *
 * Order is load-bearing: detection iterates `envVars` in registry order, so
 * forks MUST come before their parent (cursor + antigravity before
 * vscode-copilot; antigravity is a Gemini fork via Electron/VSCode).
 */

import type { HookAdapter, PlatformEnvEntry, PlatformId } from "./types.js";

/**
 * One adapter declaration. `load` is the lazy import — kept as a function so
 * the bundle keeps tree-shaking adapter modules until they're actually
 * resolved at runtime.
 */
export interface AdapterRegistryEntry {
  /** Stable platform id, mirrors the directory name under `src/adapters/`. */
  readonly id: PlatformId;
  /**
   * Path segments under `homedir()` that hold this platform's config / session
   * data. `[".claude"]` → `~/.claude`. `[".config", "opencode"]` → XDG-style.
   * `null` for `unknown` (callers fall back to platform-default).
   */
  readonly sessionDirSegments: readonly string[];
  /**
   * Env vars set by the host runtime that prove "this is the host" — checked
   * by `detectPlatform()` in registry order. Forks BEFORE parents. Empty
   * arrays are valid (kiro, openclaw rely on config-dir tier).
   */
  readonly envVars: readonly PlatformEnvEntry[];
  /** Lazy adapter loader. Preserves the dynamic-import shape from `getAdapter`. */
  readonly load: () => Promise<HookAdapter>;
}

/**
 * Authoritative list. Order is the env-var detection precedence —
 * forks listed BEFORE their parent so a Cursor session running inside
 * a VSCode-derived shell doesn't get misclassified as vscode-copilot.
 *
 * `kilo` and `opencode` BOTH resolve to `OpenCodeAdapter` with the platform id
 * passed to the constructor (the adapter is a fork-aware singleton). Keeping
 * both entries here makes that explicit at the call site.
 */
export const ADAPTER_REGISTRY: ReadonlyArray<AdapterRegistryEntry> = [
  // Claude Code — verified against a live `env` dump (2026-05-11):
  //   CLAUDE_CODE_ENTRYPOINT=cli              (set on every CC session)
  //   CLAUDE_PLUGIN_ROOT=/Users/.../<version>  (set when a plugin is loaded)
  //   CLAUDE_PROJECT_DIR=/Users/.../project    (set in hooks context)
  //   CLAUDE_SESSION_ID=<uuid>                 (legacy session marker)
  // CLAUDE_CODE_ENTRYPOINT and CLAUDE_PLUGIN_ROOT are CC-exclusive — they
  // are the disambiguators for issue #539 (Claude Code running inside a
  // VS Code integrated terminal that has VSCODE_PID set). They MUST be
  // checked here so detect resolves to claude-code BEFORE falling through
  // to vscode-copilot below.
  {
    id: "claude-code",
    sessionDirSegments: [".claude"],
    envVars: [
      { name: "CLAUDE_CODE_ENTRYPOINT", role: "identification" },
      { name: "CLAUDE_PLUGIN_ROOT",     role: "identification" },
      { name: "CLAUDE_PROJECT_DIR",     role: "workspace" },
      { name: "CLAUDE_SESSION_ID",      role: "identification" },
    ],
    load: async () => new (await import("./claude-code/index.js")).ClaudeCodeAdapter(),
  },
  // antigravity (Electron/VSCode fork) — google-gemini/gemini-cli
  // packages/core/src/ide/detect-ide.ts checks ANTIGRAVITY_CLI_ALIAS as the
  // canonical Antigravity marker. Listed BEFORE vscode-copilot.
  {
    id: "antigravity",
    sessionDirSegments: [".gemini"],
    envVars: [
      { name: "ANTIGRAVITY_CLI_ALIAS", role: "identification" },
    ],
    load: async () => new (await import("./antigravity/index.js")).AntigravityAdapter(),
  },
  // cursor (VSCode fork) — listed BEFORE vscode-copilot. CURSOR_TRACE_ID
  // has 800+ hits in major OSS detection libs (Vercel Next.js, Bun, Google
  // gemini-cli, Nx, CrewAI). CURSOR_CWD is the documented workspace var
  // (issue #521) — listed first so workspace cascade picks it up.
  {
    id: "cursor",
    sessionDirSegments: [".cursor"],
    envVars: [
      { name: "CURSOR_CWD",       role: "workspace" },
      { name: "CURSOR_TRACE_ID",  role: "identification" },
      { name: "CURSOR_CLI",       role: "identification" },
    ],
    load: async () => new (await import("./cursor/index.js")).CursorAdapter(),
  },
  // kilo (OpenCode fork) — Kilo-Org/kilocode packages/opencode/src/index.ts:138-139
  // sets process.env.KILO = 1 + process.env.KILO_PID = String(process.pid).
  {
    id: "kilo",
    sessionDirSegments: [".config", "kilo"],
    envVars: [
      { name: "KILO",     role: "identification" },
      { name: "KILO_PID", role: "identification" },
    ],
    load: async () => new (await import("./opencode/index.js")).OpenCodeAdapter("kilo"),
  },
  // opencode — sst/opencode packages/opencode/src/index.ts:108-109 sets
  // OPENCODE=1 + OPENCODE_PID=<pid> on CLI invocations. OpenCode desktop
  // shells also expose OPENCODE_CLIENT=desktop and OPENCODE_TERMINAL=1.
  // OPENCODE_PROJECT_DIR is the documented workspace var (consumed by the
  // legacy resolver cascade) — listed first so the workspace cascade picks
  // it up under strict mode.
  {
    id: "opencode",
    sessionDirSegments: [".config", "opencode"],
    envVars: [
      { name: "OPENCODE_PROJECT_DIR", role: "workspace" },
      { name: "OPENCODE_CLIENT",      role: "identification" },
      { name: "OPENCODE_TERMINAL",    role: "identification" },
      { name: "OPENCODE",             role: "identification" },
      { name: "OPENCODE_PID",         role: "identification" },
    ],
    load: async () => new (await import("./opencode/index.js")).OpenCodeAdapter("opencode"),
  },
  // zed — zed-industries/zed crates/terminal/src/terminal.rs sets ZED_TERM=true
  // in insert_zed_terminal_env(). Google's gemini-cli uses ZED_SESSION_ID.
  {
    id: "zed",
    sessionDirSegments: [".config", "zed"],
    envVars: [
      { name: "ZED_SESSION_ID", role: "identification" },
      { name: "ZED_TERM",       role: "identification" },
    ],
    load: async () => new (await import("./zed/index.js")).ZedAdapter(),
  },
  // codex — openai/codex codex-rs/core/src/exec_env.rs sets CODEX_THREAD_ID
  // per exec; unified_exec/process_manager.rs sets CODEX_CI in CI mode.
  {
    id: "codex",
    sessionDirSegments: [".codex"],
    envVars: [
      { name: "CODEX_THREAD_ID", role: "identification" },
      { name: "CODEX_CI",        role: "identification" },
    ],
    load: async () => new (await import("./codex/index.js")).CodexAdapter(),
  },
  // gemini-cli — GEMINI_PROJECT_DIR per google-gemini/gemini-cli
  // docs/hooks/index.md; GEMINI_CLI is the MCP-server sentinel.
  {
    id: "gemini-cli",
    sessionDirSegments: [".gemini"],
    envVars: [
      { name: "GEMINI_PROJECT_DIR", role: "workspace" },
      { name: "GEMINI_CLI",         role: "identification" },
    ],
    load: async () => new (await import("./gemini-cli/index.js")).GeminiCLIAdapter(),
  },
  // vscode-copilot — VSCODE_PID + VSCODE_CWD set by microsoft/vscode bootstrap.
  // Listed AFTER cursor and antigravity since they inherit these vars as forks.
  {
    id: "vscode-copilot",
    sessionDirSegments: [".vscode"],
    envVars: [
      { name: "VSCODE_CWD", role: "workspace" },
      { name: "VSCODE_PID", role: "identification" },
    ],
    load: async () => new (await import("./vscode-copilot/index.js")).VSCodeCopilotAdapter(),
  },
  // jetbrains-copilot — IDEA_INITIAL_DIRECTORY set by JetBrains launcher.
  // (IDEA_HOME and JETBRAINS_CLIENT_ID removed — no source-line evidence.)
  {
    id: "jetbrains-copilot",
    sessionDirSegments: [".config", "JetBrains"],
    envVars: [
      { name: "IDEA_INITIAL_DIRECTORY", role: "workspace" },
    ],
    load: async () => new (await import("./jetbrains-copilot/index.js")).JetBrainsCopilotAdapter(),
  },
  // qwen-code — QWEN_PROJECT_DIR per QwenLM/qwen-code docs/users/features/hooks.md.
  // (QWEN_SESSION_ID removed — 0 hits in qwen-code repository.)
  {
    id: "qwen-code",
    sessionDirSegments: [".qwen"],
    envVars: [
      { name: "QWEN_PROJECT_DIR", role: "workspace" },
    ],
    load: async () => new (await import("./qwen-code/index.js")).QwenCodeAdapter(),
  },
  // kimi (Moonshot Kimi Code) — no host env-var marker; detected via the
  // ~/.kimi-code/ config dir tier and MCP clientInfo ("kimi-code"/"Kimi Code",
  // see client-map.ts). Registry entry so getAdapter("kimi") loads KimiAdapter
  // instead of falling through to ClaudeCodeAdapter (the issue #473 data-leak
  // class). Merged from upstream's kimi support into the registry SOT.
  {
    id: "kimi",
    sessionDirSegments: [".kimi-code"],
    envVars: [],
    load: async () => new (await import("./kimi/index.js")).KimiAdapter(),
  },
  // omp (can1357/oh-my-pi). PI_CODING_AGENT_DIR is the upstream agent-dir
  // override per packages/utils/src/dirs.ts:193. Listed BEFORE pi so OMP
  // is not misclassified as Pi when both are installed.
  {
    id: "omp",
    sessionDirSegments: [".omp"],
    envVars: [
      { name: "PI_CODING_AGENT_DIR", role: "workspace" },
    ],
    load: async () => new (await import("./omp/index.js")).OMPAdapter(),
  },
  // pi — Issue #542 marker correction. PI_PROJECT_DIR is a consumer-set
  // var (read by src/adapters/pi/extension.ts) but is NOT auto-set by
  // the Pi runtime — verified against
  //   refs/platforms/oh-my-pi/packages/coding-agent/src/mcp/transports/stdio.ts:55-63
  // (env passthrough only, no synthesis). The Pi runtime DOES set
  // PI_CONFIG_DIR (config dir override), PI_SESSION_FILE (active session
  // path), and PI_COMPILED (binary build marker). PI_CODING_AGENT_DIR is
  // owned by OMP above; keep it there.
  //
  // Issue #545 — PI_WORKSPACE_DIR / PI_PROJECT_DIR are workspace vars set
  // by Pi's bridge so the resolver picks them up under strict mode.
  // PI_WORKSPACE_DIR comes first (extension-set, freshest) before
  // PI_PROJECT_DIR (user override) per registry-author cascade order.
  //
  // Issue #473 follow-up: without this entry, getAdapter("pi") fell through
  // to ClaudeCodeAdapter and Pi sessions wrote into ~/.claude/context-mode/.
  // PiAdapter pins storage to ~/.pi/.
  {
    id: "pi",
    sessionDirSegments: [".pi"],
    envVars: [
      // detect=false because PI_*_DIR are consumer-set and must NOT
      // misclassify a non-Pi host as Pi (#542).
      { name: "PI_WORKSPACE_DIR", role: "workspace",      detect: false },
      { name: "PI_PROJECT_DIR",   role: "workspace",      detect: false },
      { name: "PI_CONFIG_DIR",    role: "identification" },
      { name: "PI_SESSION_FILE",  role: "identification" },
      { name: "PI_COMPILED",      role: "identification" },
    ],
    load: async () => new (await import("./pi/index.js")).PiAdapter(),
  },
  // openclaw — runtime never sets OPENCLAW_HOME or OPENCLAW_CLI; detection
  // falls through to ~/.openclaw/ config-dir tier in detect.ts.
  {
    id: "openclaw",
    sessionDirSegments: [".openclaw"],
    envVars: [],
    load: async () => new (await import("./openclaw/index.js")).OpenClawAdapter(),
  },
  // kiro — no auto-set process env vars; detection falls through to
  // ~/.kiro/ config-dir tier in detect.ts (or MCP clientInfo handshake).
  {
    id: "kiro",
    sessionDirSegments: [".kiro"],
    envVars: [],
    load: async () => new (await import("./kiro/index.js")).KiroAdapter(),
  },
];

/** Index for O(1) lookup. Built once at module-load time. */
const REGISTRY_BY_ID: ReadonlyMap<PlatformId, AdapterRegistryEntry> = new Map(
  ADAPTER_REGISTRY.map((entry) => [entry.id, entry] as const),
);

/** Lookup a registry entry by id, or `undefined` for `"unknown"`/typos. */
export function getRegistryEntry(id: PlatformId | string): AdapterRegistryEntry | undefined {
  return REGISTRY_BY_ID.get(id as PlatformId);
}

/** Set of every id present in the registry. Useful for matrix tests. */
export const REGISTERED_PLATFORM_IDS: ReadonlySet<PlatformId> = new Set(
  ADAPTER_REGISTRY.map((entry) => entry.id),
);
