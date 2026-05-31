/**
 * adapters/registry — single source of truth for the 15 supported platforms.
 *
 * Before this module the same platform set was redeclared in three places
 * inside `detect.ts`: `_PLATFORM_ENV_VARS_RAW` (env-var detection),
 * `getSessionDirSegments` (sync session-dir lookup) and `getAdapter` (lazy
 * adapter loader). Adding adapter #16 required editing all three; missing
 * one slot was silent (cf. issue #473 follow-up for `pi`).
 *
 * Now each adapter is declared once below. `detect.ts` derives the env-var
 * map, the session-dir lookup and the adapter loader from this list, and a
 * test in `tests/adapter-registry.test.ts` asserts every directory under
 * `src/adapters/<id>/` has a matching registry entry.
 *
 * Doc-comment intent and inline issue references on env-var entries live in
 * `detect.ts` next to `PLATFORM_ENV_VARS` — this file is the spine, not the
 * narrative.
 */

import type { HookAdapter, PlatformId } from "./types.js";

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
  /** Lazy adapter loader. Preserves the dynamic-import shape from `getAdapter`. */
  readonly load: () => Promise<HookAdapter>;
}

/**
 * Authoritative list. Order matches the historical `getAdapter` switch — kept
 * stable so future grep diffs against the legacy switch stay readable.
 *
 * `kilo` and `opencode` BOTH resolve to `OpenCodeAdapter` with the platform id
 * passed to the constructor (the adapter is a fork-aware singleton). Keeping
 * both entries here makes that explicit at the call site.
 */
export const ADAPTER_REGISTRY: ReadonlyArray<AdapterRegistryEntry> = [
  {
    id: "claude-code",
    sessionDirSegments: [".claude"],
    load: async () => new (await import("./claude-code/index.js")).ClaudeCodeAdapter(),
  },
  {
    id: "gemini-cli",
    sessionDirSegments: [".gemini"],
    load: async () => new (await import("./gemini-cli/index.js")).GeminiCLIAdapter(),
  },
  {
    id: "antigravity",
    sessionDirSegments: [".gemini"],
    load: async () => new (await import("./antigravity/index.js")).AntigravityAdapter(),
  },
  {
    id: "openclaw",
    sessionDirSegments: [".openclaw"],
    load: async () => new (await import("./openclaw/index.js")).OpenClawAdapter(),
  },
  {
    id: "codex",
    sessionDirSegments: [".codex"],
    load: async () => new (await import("./codex/index.js")).CodexAdapter(),
  },
  {
    id: "cursor",
    sessionDirSegments: [".cursor"],
    load: async () => new (await import("./cursor/index.js")).CursorAdapter(),
  },
  {
    id: "vscode-copilot",
    sessionDirSegments: [".vscode"],
    load: async () => new (await import("./vscode-copilot/index.js")).VSCodeCopilotAdapter(),
  },
  {
    id: "kiro",
    sessionDirSegments: [".kiro"],
    load: async () => new (await import("./kiro/index.js")).KiroAdapter(),
  },
  {
    // Issue #473 follow-up: without this entry, getAdapter("pi") fell through
    // to ClaudeCodeAdapter and Pi sessions wrote into ~/.claude/context-mode/.
    // PiAdapter pins storage to ~/.pi/.
    id: "pi",
    sessionDirSegments: [".pi"],
    load: async () => new (await import("./pi/index.js")).PiAdapter(),
  },
  {
    id: "omp",
    sessionDirSegments: [".omp"],
    load: async () => new (await import("./omp/index.js")).OMPAdapter(),
  },
  {
    id: "qwen-code",
    sessionDirSegments: [".qwen"],
    load: async () => new (await import("./qwen-code/index.js")).QwenCodeAdapter(),
  },
  {
    id: "kilo",
    sessionDirSegments: [".config", "kilo"],
    load: async () => new (await import("./opencode/index.js")).OpenCodeAdapter("kilo"),
  },
  {
    id: "opencode",
    sessionDirSegments: [".config", "opencode"],
    load: async () => new (await import("./opencode/index.js")).OpenCodeAdapter("opencode"),
  },
  {
    id: "zed",
    sessionDirSegments: [".config", "zed"],
    load: async () => new (await import("./zed/index.js")).ZedAdapter(),
  },
  {
    id: "jetbrains-copilot",
    sessionDirSegments: [".config", "JetBrains"],
    load: async () => new (await import("./jetbrains-copilot/index.js")).JetBrainsCopilotAdapter(),
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
