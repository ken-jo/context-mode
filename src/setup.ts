/**
 * context-mode setup — auto-detect host CLI and apply canonical config.
 *
 * Goal: replace the 14× repeated "edit this JSON file" README sections with a
 * single command:
 *
 *   $ context-mode setup            # auto-detect, write hooks + MCP registration
 *   $ context-mode setup --check    # dry-run, exit 1 if changes would apply
 *   $ context-mode setup gemini-cli # force a specific platform
 *
 * Per-platform behavior (MVP — see docs/setup-improvements.md A1):
 *
 *   json-stdio platforms (gemini-cli, vscode-copilot, cursor, qwen-code, kiro):
 *     1. Hooks  → adapter.configureAllHooks(pluginRoot)  (existing path)
 *     2. MCP    → idempotent merge into the platform's mcp/servers JSON
 *
 *   marketplace / native-managed (claude-code, opencode, kilo, openclaw,
 *   pi, omp): noop with a one-line pointer to the README path that handles it.
 *
 *   UI-only (jetbrains-copilot): print the exact UI steps.
 *
 *   TOML (codex): print the manual snippet — deferred until we wire a parser.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import * as p from "@clack/prompts";
import color from "picocolors";

import { detectPlatform, getAdapter } from "./adapters/detect.js";
import { REGISTERED_PLATFORM_IDS } from "./adapters/registry.js";
import { zedSettingsPath } from "./adapters/zed/index.js";
import type { PlatformId } from "./adapters/types.js";
import { parseJsonc } from "./util/jsonc.js";

export interface SetupOptions {
  /** Explicit platform; bypasses detection. */
  platform?: PlatformId;
  /** Dry-run — print would-be changes, exit 1 when drift exists. */
  check?: boolean;
  /** Re-write even when current state already matches. */
  force?: boolean;
  /** Remove context-mode keys instead of writing them — Item A4. */
  uninstall?: boolean;
  /** For project-vs-user scoped platforms (cursor, vscode-copilot). */
  scope?: "user" | "project";
  /** Project root (defaults to process.cwd()). */
  projectDir?: string;
  /** Plugin install root — passed to adapter.configureAllHooks. */
  pluginRoot: string;
}

export type SetupOutcome =
  | "applied"      // changes written
  | "noop"         // already up to date
  | "drift"        // --check found pending changes (exit 1)
  | "manual"       // user must follow printed steps (UI / TOML / external installer)
  | "unsupported"; // platform id unknown

export interface SetupResult {
  platform: PlatformId;
  outcome: SetupOutcome;
  changes: string[];
  warnings: string[];
  /** Optional next-step hint shown after the summary. */
  hint?: string;
}

/* ─────────── JSON I/O helpers ─────────── */

/**
 * Read a JSON object for merging. Three cases:
 *   - missing file        → { root: {} }                  (start fresh, safe)
 *   - parses to an object → { root: <parsed> }            (merge into it)
 *   - parse error / non-object → preserve the original by copying it to
 *     `<path>.broken` (unless dryRun), return { root: {}, backedUp }.
 *
 * Second-pass workflow finding (HIGH): the old `readJsonOrDefault` returned
 * `{}` on ANY parse error, and the subsequent atomic write then silently
 * WIPED every sibling MCP server + comments. VS Code `mcp.json` is officially
 * JSONC, so even a valid commented file tripped it. Backing up before reset
 * (like the codex adapter) makes the data loss recoverable + visible.
 */
function readJsonForMerge(
  path: string,
  dryRun: boolean,
): { root: Record<string, unknown>; backedUp?: string; parseError?: boolean } {
  if (!existsSync(path)) return { root: {} };
  let raw: string;
  try { raw = readFileSync(path, "utf-8"); } catch { return { root: {} }; }
  // JSONC-tolerant parse (comments + trailing commas) via the shared util.
  // VS Code mcp.json is officially JSONC, so a VALID commented file must
  // merge in place — preserving sibling servers — not get reset. Only a
  // genuinely unparseable file is backed up + replaced. (Loop-1 finding: the
  // strict-only parse treated valid JSONC as broken and dropped siblings.)
  const parsed = parseJsonc<unknown>(raw);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return { root: parsed as Record<string, unknown> };
  }
  const backedUp = `${path}.broken`;
  if (!dryRun) {
    try { writeFileSync(backedUp, raw, "utf-8"); } catch { /* best effort */ }
  }
  return { root: {}, backedUp, parseError: true };
}

function writeJsonAtomic(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf-8");
  try {
    renameSync(tmp, path);
  } catch {
    // Cross-device fallback — copy + unlink
    const data = readFileSync(tmp);
    writeFileSync(path, data);
    try { unlinkSync(tmp); } catch { /* leak — best effort */ }
  }
}

/**
 * Shallow-merge `desired` over any existing object value so a user's extra
 * fields on the context-mode server entry (e.g. `env` / `args`) survive a
 * re-run. Non-object existing → desired wins. (Second-pass finding: the old
 * wholesale replace dropped user-added fields on the context-mode entry.)
 */
function mergedValue(existing: unknown, desired: unknown): unknown {
  if (
    existing && typeof existing === "object" && !Array.isArray(existing) &&
    desired && typeof desired === "object" && !Array.isArray(desired)
  ) {
    return { ...(existing as Record<string, unknown>), ...(desired as Record<string, unknown>) };
  }
  return desired;
}

/* ─────────── MCP server registration per platform ─────────── */

interface McpRegHandler {
  /** Human description for the summary line. */
  label: string;
  /** Resolve the target JSON path; may depend on scope/projectDir. */
  resolvePath: (opts: { scope: "user" | "project"; projectDir: string }) => string;
  /** Top-level key holding the server map (e.g. "mcpServers", "servers"). */
  containerKey: string;
  /** Sub-key inside the container — usually "context-mode". */
  serverKey?: string;
  /** Desired value for `container[serverKey]`. */
  desired?: unknown;
}

const SERVER_KEY = "context-mode";
const DESIRED_SERVER = { command: "context-mode" } as const;

const MCP_REGISTRATIONS: Partial<Record<PlatformId, McpRegHandler>> = {
  "gemini-cli": {
    label: "Gemini settings.json mcpServers",
    resolvePath: () => resolve(homedir(), ".gemini", "settings.json"),
    containerKey: "mcpServers",
  },
  "vscode-copilot": {
    label: "VS Code mcp.json servers",
    resolvePath: ({ scope, projectDir }) =>
      scope === "user"
        ? resolve(homedir(), ".vscode", "mcp.json")
        : resolve(projectDir, ".vscode", "mcp.json"),
    containerKey: "servers",
  },
  "cursor": {
    label: "Cursor mcp.json mcpServers",
    resolvePath: ({ scope, projectDir }) =>
      scope === "user"
        ? resolve(homedir(), ".cursor", "mcp.json")
        : resolve(projectDir, ".cursor", "mcp.json"),
    containerKey: "mcpServers",
  },
  "qwen-code": {
    label: "Qwen settings.json mcpServers",
    resolvePath: () => resolve(homedir(), ".qwen", "settings.json"),
    containerKey: "mcpServers",
  },
  "kiro": {
    label: "Kiro settings/mcp.json mcpServers",
    // Kiro supports both ~/.kiro/settings/mcp.json (user) and
    // <project>/.kiro/settings/mcp.json (project). The KiroAdapter's
    // getSettingsPath() — the file `doctor` reads — is the USER-HOME path,
    // so user scope is the default (see scope defaults below). Honor an
    // explicit --scope project. Verified against the adapter + Kiro MCP docs
    // (kiro.dev/docs/mcp/configuration). Fixes the setup↔doctor split where
    // setup wrote the project file the adapter never reads.
    resolvePath: ({ scope, projectDir }) =>
      scope === "user"
        ? resolve(homedir(), ".kiro", "settings", "mcp.json")
        : resolve(projectDir, ".kiro", "settings", "mcp.json"),
    containerKey: "mcpServers",
  },
  "antigravity": {
    label: "Antigravity mcp_config.json mcpServers",
    // Antigravity nests its MCP config under ~/.gemini/antigravity/ and the
    // file is literally `mcp_config.json` (NOT mcp.json). The AntigravityAdapter
    // getConfigDir() is home-rooted and ignores projectDir, and
    // checkPluginRegistration() — the file `doctor` reads — reads exactly this
    // path. So setup must write the same home-rooted file; scope is ignored.
    // Verified against src/adapters/antigravity/index.ts + docs/platform-support.md
    // + antigravity.google/docs/mcp. Fixes the 3-axis setup↔doctor divergence
    // (wrong dir .antigravity vs .gemini/antigravity, wrong filename, wrong scope).
    resolvePath: () => resolve(homedir(), ".gemini", "antigravity", "mcp_config.json"),
    containerKey: "mcpServers",
  },
  "zed": {
    label: "Zed settings.json context_servers",
    // Platform-aware (Windows uses %LOCALAPPDATA%\Zed, not ~/.config) —
    // shared with ZedAdapter.getSettingsPath so setup writes where doctor +
    // Zed read. (Loop-3 Windows fix.)
    resolvePath: () => zedSettingsPath(),
    containerKey: "context_servers",
    serverKey: SERVER_KEY,
    // Command-only (no `args: []`). Zed accepts a flat entry without args, and
    // including an empty `args` key made mergedValue() reset a user's
    // hand-edited `args` on every re-run — the one managed-field clobber the
    // merge contract promises not to do. (Loop-4 finding.)
    // Zed's context_servers Stdio variant flattens ContextServerCommand and
    // renames its `path` field to the JSON key `command` — so the accepted
    // shape is a FLAT string: { "command": "context-mode", "args": [] }. The
    // old nested { command: { path, args } } form fails to deserialize under
    // Zed's #[serde(untagged)] enum and is silently dropped (server never
    // loads). Verified against zed-industries/zed
    // crates/settings_content/src/project.rs + zed.dev/docs/ai/mcp.
    // (Loop-1 workflow finding.)
    desired: { command: "context-mode" },
  },
};

/**
 * Public helper — invoked from `context-mode upgrade` so the MCP server
 * registration refreshes alongside hooks when the user runs /ctx-upgrade.
 * Without this call the upgrade only touches hooks + plugin-registry; any
 * `.cursor/mcp.json` / `~/.gemini/settings.json` mcpServers entry that was
 * never written (or got stale) silently lingers.
 *
 * Item A7 of docs/setup-improvements.md.
 *
 * @returns null when the platform has no separate mcp.json/settings.json to
 * register against (e.g. claude-code uses the plugin marketplace).
 */
export function refreshMcpRegistration(
  platform: PlatformId,
  opts: { check?: boolean; scope?: "user" | "project"; projectDir?: string } = {},
): { changed: boolean; path?: string; desc: string } | null {
  return applyMcpRegistration(platform, {
    check: opts.check ?? false,
    scope: opts.scope ?? defaultScopeFor(platform),
    projectDir: opts.projectDir ?? process.cwd(),
  });
}

/**
 * Default scope per platform. Only vscode-copilot and cursor are project-first
 * — their canonical MCP file is `<project>/.vscode/mcp.json` /
 * `<project>/.cursor/mcp.json`. Every other platform (including kiro and
 * antigravity) is user-home rooted because that is the file the platform's
 * adapter `checkPluginRegistration()` (i.e. `doctor`) reads; defaulting them
 * to project scope would write a file doctor never inspects.
 */
function defaultScopeFor(platform: PlatformId): "user" | "project" {
  return platform === "vscode-copilot" || platform === "cursor"
    ? "project"
    : "user";
}

/**
 * Item A4 — remove the `context-mode` entry from the platform's MCP
 * servers map. Preserves every sibling key the user added. Leaves the
 * containing file in place even when the resulting map is empty — that
 * matches `mcp.json` schema (`{ "mcpServers": {} }` is a valid empty
 * config; deleting the file would silently destroy a user's empty-but-
 * intentional state).
 *
 * Returns null when the platform has no separate mcp file to touch.
 */
function removeMcpRegistration(
  platform: PlatformId,
  opts: { check: boolean; scope: "user" | "project"; projectDir: string },
): { changed: boolean; path?: string; desc: string } | null {
  const handler = MCP_REGISTRATIONS[platform];
  if (!handler) return null;
  const path = handler.resolvePath({ scope: opts.scope, projectDir: opts.projectDir });
  const container = handler.containerKey;
  const sub = handler.serverKey ?? SERVER_KEY;

  if (!existsSync(path)) {
    return { changed: false, path, desc: `${handler.label}: nothing to remove (file not present)` };
  }
  const { root, parseError, backedUp } = readJsonForMerge(path, !!opts.check);
  if (parseError) {
    // Never overwrite an unparseable file on uninstall — we cannot know what
    // to remove. Report + (outside dry-run) preserve a .broken copy.
    return {
      changed: false,
      path,
      desc: `${handler.label}: could not parse — left untouched${backedUp ? ` (backed up to ${backedUp})` : ""}; remove the context-mode entry manually`,
    };
  }
  const servers = (root[container] && typeof root[container] === "object" && !Array.isArray(root[container])
    ? (root[container] as Record<string, unknown>)
    : null);
  if (!servers || !(sub in servers)) {
    return { changed: false, path, desc: `${handler.label}: ${sub} not registered` };
  }
  if (opts.check) {
    return { changed: true, path, desc: `${handler.label}: WOULD REMOVE ${sub}` };
  }
  delete servers[sub];
  // Re-attach container (in case we replaced an undefined). Keep empty {}
  // intentionally — see jsdoc above.
  root[container] = servers;
  writeJsonAtomic(path, root);
  return { changed: true, path, desc: `${handler.label}: removed ${sub}` };
}

function applyMcpRegistration(
  platform: PlatformId,
  opts: { check: boolean; scope: "user" | "project"; projectDir: string; force?: boolean },
): { changed: boolean; path?: string; desc: string } | null {
  const handler = MCP_REGISTRATIONS[platform];
  if (!handler) return null;
  const path = handler.resolvePath({ scope: opts.scope, projectDir: opts.projectDir });
  const container = handler.containerKey;
  const sub = handler.serverKey ?? SERVER_KEY;
  const desired = handler.desired ?? DESIRED_SERVER;

  const { root, backedUp } = readJsonForMerge(path, !!opts.check);
  const backupNote = backedUp
    ? (opts.check ? ` (would back up malformed file to ${backedUp})` : ` (backed up malformed file to ${backedUp})`)
    : "";
  const servers = (root[container] && typeof root[container] === "object" && !Array.isArray(root[container])
    ? (root[container] as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  // Merge desired over any existing entry so user-added fields (env/args) on
  // the context-mode server survive. `--force` re-writes even when equal.
  const next = mergedValue(servers[sub], desired);
  const wouldChange = JSON.stringify(servers[sub]) !== JSON.stringify(next);
  if (!wouldChange && !opts.force) {
    return { changed: false, path, desc: `${handler.label}: up-to-date${backupNote}` };
  }
  if (opts.check) {
    return { changed: true, path, desc: `${handler.label}: WOULD WRITE${backupNote}` };
  }
  servers[sub] = next;
  root[container] = servers;
  writeJsonAtomic(path, root);
  return { changed: true, path, desc: `${handler.label}: wrote ${sub}${backupNote}` };
}

/* ─────────── External/manual platform messages ─────────── */

const MANUAL_HINTS: Partial<Record<PlatformId, string>> = {
  "claude-code":
    "Installed via Claude Code marketplace. Run `/plugin install context-mode@context-mode` inside Claude Code.",
  "opencode":
    "OpenCode auto-installs the plugin from npm into ~/.cache/opencode/packages/... Add `\"context-mode\"` to the `plugin` array in ~/.config/opencode/opencode.json (or opencode.jsonc) — this is the file `context-mode doctor` reads. config.json is also loaded by OpenCode but doctor inspects opencode.json.",
  "kilo":
    "KiloCode auto-installs the plugin from npm into its package cache. Add `\"context-mode\"` to the `plugin` array (key is singular) in ~/.config/kilo/kilo.json (or kilo.jsonc) — this is the file `context-mode doctor` reads. Project kilo.json / .kilo/kilo.json / .kilocode/kilo.json also work. On Windows the global dir is %APPDATA%\\kilo; XDG_CONFIG_HOME is honored when set.",
  "openclaw":
    "OpenClaw uses a native gateway plugin. Run `npm run install:openclaw` from the plugin root.",
  "pi":
    "Pi loads extensions from ~/.pi/agent/extensions/context-mode/ (global, per earendil-works/pi docs/extensions.md) or .pi/extensions/context-mode/ (project). The PiAdapter (the path `context-mode doctor` checks) resolves the global ~/.pi/agent/extensions/context-mode/. (postinstall does not auto-install the Pi extension; see docs/setup-improvements.md DI-7.)",
  "omp":
    "OMP loads MCP servers from ~/.omp/agent/mcp.json (key: mcpServers) — the exact file+key `context-mode doctor` checks. Add: \"mcpServers\": { \"context-mode\": { \"command\": \"context-mode\" } }. (PI_CODING_AGENT_DIR overrides ~/.omp/agent.)",
  // NOTE: codex is intentionally NOT here. It is HOOK_CAPABLE with a real
  // configureAllHooks (writes ~/.codex/hooks.json + enables the feature
  // flag), so it must flow through the hooks path rather than short-circuit.
  // Its MCP registration is TOML (no MCP_REGISTRATIONS entry); see
  // POST_SETUP_NOTES["codex"] for the TOML snippet printed after hooks run.
  "jetbrains-copilot":
    "JetBrains GitHub Copilot adds MCP via the GitHub Copilot menu (NOT JetBrains' own 'AI Assistant'):\n    GitHub Copilot icon > Edit Settings > Model Context Protocol > Configure\n    (equivalently Settings > Tools > GitHub Copilot > Model Context Protocol (MCP) > Configure)\n  This opens an mcp.json with a top-level `servers` key:\n      { \"servers\": { \"context-mode\": { \"command\": \"context-mode\" } } }\n  Then drop `.github/hooks/context-mode.json` (see configs/jetbrains-copilot/hooks.json).",
};

/**
 * Explicit uninstall instructions for the manual platforms. Replaces the
 * earlier naive `manual.replace(/install/gi, "uninstall")` which produced
 * nonexistent commands (`npm run uninstall:openclaw`) and "Add the server
 * you're removing" nonsense. (Second-pass workflow finding.)
 */
const UNINSTALL_HINTS: Partial<Record<PlatformId, string>> = {
  "claude-code":
    "Run `/plugin uninstall context-mode@context-mode` inside Claude Code (or remove it from the marketplace UI).",
  "opencode":
    "Remove `\"context-mode\"` from the `plugin` array in ~/.config/opencode/opencode.json (or opencode.jsonc).",
  "kilo":
    "Remove `\"context-mode\"` from the `plugin` array (key is singular) in ~/.config/kilo/kilo.json (or kilo.jsonc) — or whichever kilo.json the host loaded.",
  "openclaw":
    "Remove the context-mode entry from `plugins.entries` (and `mcp.servers`) in your openclaw.json; there is no automated uninstall script.",
  "pi":
    "Delete the context-mode extension directory under your Pi agent dir (~/.pi/agent/extensions/context-mode/ global, or .pi/extensions/context-mode/ project).",
  "omp":
    "Remove the context-mode entry from `mcpServers` in ~/.omp/agent/mcp.json.",
  "jetbrains-copilot":
    "Remove the context-mode server from the GitHub Copilot MCP config (GitHub Copilot icon > Edit Settings > Model Context Protocol > Configure) and delete `.github/hooks/context-mode.json`.",
};

/**
 * Informational notes printed AFTER the automated setup steps for platforms
 * that need an additional manual step the auto-writer cannot do. codex needs
 * its MCP server registered via TOML (no JSON MCP_REGISTRATIONS entry); its
 * hooks ARE auto-configured via the hooks path.
 */
const POST_SETUP_NOTES: Partial<Record<PlatformId, string>> = {
  "codex":
    "Codex MCP registration uses TOML. Add this to ~/.codex/config.toml (hooks were configured automatically above):\n\n  [mcp_servers.context-mode]\n  command = \"context-mode\"\n\n(Automated TOML editing is on the roadmap.)",
};

/* ─────────── Hook configuration via adapter.configureAllHooks ─────────── */

const HOOK_CAPABLE: ReadonlySet<PlatformId> = new Set([
  "claude-code", "gemini-cli", "vscode-copilot", "cursor", "qwen-code",
  "kiro", "codex", // codex has its own hooks.json path
]);

/**
 * Item E2 of docs/setup-improvements.md — adapters whose `paradigm` is
 * `"mcp-only"`. These hosts have no hook surface and rely on a rules file
 * (AGENTS.md / GEMINI.md) for routing nudges; the model follows ~60% per
 * upstream measurements. Surfaced in setup output + doctor so users do not
 * mistake "Setup complete" for hook-grade enforcement.
 */
const MCP_ONLY_PARADIGM: ReadonlySet<PlatformId> = new Set([
  "antigravity", "zed",
]);

async function applyHooksViaAdapter(
  platform: PlatformId,
  pluginRoot: string,
  check: boolean,
): Promise<{ changed: boolean; desc: string }> {
  if (!HOOK_CAPABLE.has(platform)) {
    return { changed: false, desc: "Hooks: not applicable for this platform" };
  }
  // Items DI-1 + DI-6 — `configureAllHooks` is idempotent across all
  // hook-capable adapters (claude-code, gemini-cli, vscode-copilot, cursor,
  // qwen-code, codex): it skips the write and returns an empty `changes`
  // array when the on-disk entries already match desired. In --check mode we
  // do NOT run it (it is destructive) and it does NOT contribute to the drift
  // exit code (the caller ignores `changed` here); we just print an info line.
  if (check) {
    return {
      changed: false,
      desc: "Hooks: idempotent — a real `context-mode setup` refreshes them (no-op when already current)",
    };
  }
  const adapter = await getAdapter(platform);
  const changes = adapter.configureAllHooks(pluginRoot);
  if (changes.length === 0) {
    return { changed: false, desc: "Hooks: up-to-date" };
  }
  return { changed: true, desc: `Hooks: ${changes.length} change(s) — ${changes.join("; ")}` };
}

/* ─────────── Main entry ─────────── */

export async function runSetup(opts: SetupOptions): Promise<number> {
  p.intro(color.bgMagenta(color.white(" context-mode setup ")));

  const projectDir = opts.projectDir ?? process.cwd();
  const detection = opts.platform
    ? { platform: opts.platform, confidence: "high" as const, reason: "explicit --platform / arg" }
    : detectPlatform();
  const platform = detection.platform;

  p.log.info(
    `Platform: ${color.cyan(platform)}` +
      color.dim(`  (${detection.confidence} confidence — ${detection.reason})`),
  );

  // Unknown / undetected / INVALID-explicit-arg platform — don't print a
  // green "Already configured" having written nothing. Catches both an
  // undetected host AND an invalid explicit arg like `setup foobar` (which
  // would otherwise fall through with confidence "high"). (Loop-1/Loop-2.)
  if (!REGISTERED_PLATFORM_IDS.has(platform)) {
    p.log.warn(color.yellow(`Not a supported agent CLI: "${platform}".`));
    p.note(
      "Pass an explicit platform, e.g. `context-mode setup gemini-cli`.\n" +
        "Supported: claude-code, gemini-cli, vscode-copilot, cursor, qwen-code,\n" +
        "kiro, antigravity, zed, codex, jetbrains-copilot, opencode, kilo,\n" +
        "openclaw, pi, omp.",
      "unsupported",
    );
    p.outro(color.yellow("No changes written — platform not detected."));
    return 2;
  }

  // Item E2 — honesty banner for MCP-only paradigm hosts. Routing relies
  // on a rules file (AGENTS.md / GEMINI.md), not on hooks.
  if (MCP_ONLY_PARADIGM.has(platform)) {
    p.log.warn(
      color.yellow("Routing fidelity: best-effort (~60%)") +
        color.dim(` — ${platform} has no hook surface; routing relies on a rules file`),
    );
  }

  // Default scope: vscode-copilot and cursor are project-first because their
  // canonical install path is per-project. Others are user-scoped — see
  // defaultScopeFor() (single source of truth shared with refreshMcpRegistration).
  let scope: "user" | "project" = opts.scope ?? defaultScopeFor(platform);

  // VS Code has no `~/.vscode/mcp.json` — MCP servers are workspace-scoped
  // (.vscode/mcp.json) or live in the VS Code user-profile dir (not a simple
  // home file). An explicit `--scope user` would write a file VS Code never
  // loads, so force project scope with a warning. (Loop-2 finding.)
  if (platform === "vscode-copilot" && scope === "user") {
    p.log.warn(
      color.yellow("VS Code MCP is workspace-scoped — ignoring --scope user.") +
        color.dim(" Writing project .vscode/mcp.json (VS Code has no ~/.vscode/mcp.json)."),
    );
    scope = "project";
  }

  const changes: string[] = [];
  const warnings: string[] = [];
  let driftSeen = false;
  let hadFailure = false;
  let outcome: SetupOutcome = "noop";

  // ── External / manual platforms ──
  const manual = MANUAL_HINTS[platform];
  if (manual) {
    if (opts.uninstall) {
      // Use the explicit uninstall hint (NOT a naive install→uninstall
      // regex, which produced nonexistent commands).
      const uninstallHint = UNINSTALL_HINTS[platform] ?? manual;
      p.log.warn(color.yellow("Uninstall is managed externally for this platform."));
      p.note(uninstallHint, platform);
    } else {
      p.log.warn(color.yellow("Setup is managed externally for this platform."));
      p.note(manual, platform);
    }
    outcome = "manual";
    p.outro(color.dim("No files written. See docs/setup-improvements.md for automation roadmap."));
    return 0;
  }

  // ── Uninstall path — Item A4 ──
  if (opts.uninstall) {
    try {
      const r = removeMcpRegistration(platform, {
        check: !!opts.check,
        scope,
        projectDir,
      });
      if (r === null) {
        p.log.info(color.dim("MCP unregister: not applicable for this platform"));
      } else if (r.changed) {
        if (opts.check) driftSeen = true;
        else outcome = "applied";
        p.log.success(color.green(r.desc) + color.dim(` — ${r.path}`));
        changes.push(`${r.desc} (${r.path})`);
      } else {
        p.log.info(color.dim(r.desc) + color.dim(` — ${r.path}`));
        changes.push(r.desc);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      p.log.error(color.red(`MCP unregister: FAIL — ${msg}`));
      warnings.push(`uninstall mcp: ${msg}`);
      hadFailure = true;
    }
    // Hooks removal is adapter-specific (each adapter writes its own keys);
    // for the MVP we point the user at manual removal rather than risking
    // damage to user-managed hook entries that happen to share our matcher
    // pattern. Tracked as A4b follow-up.
    p.log.info(
      color.dim("Hook entries (if any) left in place — remove manually from your platform's hooks.json."),
    );
    // A real unregister write failure → non-zero exit (mirrors the install
    // path; previously the uninstall branch always exited 0). (Loop-1 finding.)
    if (hadFailure) {
      p.outro(color.red("Uninstall finished with errors — see the FAIL lines above."));
      return 1;
    }
    if (opts.check && driftSeen) {
      p.outro(color.yellow("Drift detected — re-run without --check to apply."));
      return 1;
    }
    if (outcome === "applied") {
      p.outro(color.green("Uninstall complete (MCP registration removed)."));
    } else {
      p.outro(color.green("Already uninstalled — nothing to do."));
    }
    return 0;
  }

  // ── 1. Hooks (adapter.configureAllHooks) ──
  // NOTE: in --check mode, hooks do NOT contribute to drift/exit-code. We
  // cannot truly dry-run configureAllHooks (it is destructive) and the
  // adapters are idempotent, so a phantom "hooks would change" must not make
  // `--check` always exit 1. Only MCP registration (deterministic, real
  // dry-run) drives the drift exit code. (Second-pass workflow finding.)
  try {
    const hookResult = await applyHooksViaAdapter(platform, opts.pluginRoot, !!opts.check);
    if (opts.check) {
      p.log.info(color.dim(hookResult.desc));
    } else if (hookResult.changed) {
      outcome = "applied";
      p.log.success(color.green(hookResult.desc));
    } else {
      p.log.info(color.dim(hookResult.desc));
    }
    changes.push(hookResult.desc);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    p.log.error(color.red(`Hooks: FAIL — ${msg}`));
    warnings.push(`hooks: ${msg}`);
    hadFailure = true;
  }

  // ── 2. MCP server registration ──
  try {
    const mcpResult = applyMcpRegistration(platform, {
      check: !!opts.check,
      scope,
      projectDir,
      force: opts.force,
    });
    if (mcpResult === null) {
      p.log.info(color.dim("MCP registration: handled by hook config (no separate file)"));
    } else if (mcpResult.changed) {
      if (opts.check) driftSeen = true;
      else outcome = "applied";
      p.log.success(color.green(mcpResult.desc) + color.dim(` — ${mcpResult.path}`));
      changes.push(`${mcpResult.desc} (${mcpResult.path})`);
    } else {
      p.log.info(color.dim(mcpResult.desc) + color.dim(` — ${mcpResult.path}`));
      changes.push(mcpResult.desc);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    p.log.error(color.red(`MCP registration: FAIL — ${msg}`));
    warnings.push(`mcp: ${msg}`);
    hadFailure = true;
  }

  // ── 2b. Post-setup note (e.g. codex TOML MCP registration) ──
  const postNote = POST_SETUP_NOTES[platform];
  if (postNote && !opts.check) {
    p.note(postNote, platform);
  }

  // ── 3. Outcome ──
  const _result: SetupResult = { platform, outcome, changes, warnings };
  void _result;

  // Real write failure → non-zero exit even if some steps succeeded, so CI
  // and scripts can detect a partial setup failure (was silently exit 0).
  if (hadFailure) {
    p.outro(color.red("Setup finished with errors — see the FAIL lines above."));
    return 1;
  }
  if (opts.check && driftSeen) {
    outcome = "drift";
    p.outro(color.yellow("Drift detected — re-run without --check to apply."));
    return 1;
  }
  if (opts.check) {
    p.outro(color.green("No MCP-registration drift. (Hooks are refreshed idempotently on a real run.)"));
    return 0;
  }
  if (outcome === "applied") {
    p.outro(color.green("Setup complete. Run `context-mode doctor` to verify."));
  } else {
    p.outro(color.green("Already configured — nothing to do."));
  }
  return 0;
}
