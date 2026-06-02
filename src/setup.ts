/**
 * context-mode setup — auto-detect host CLI and apply canonical config.
 *
 * Goal: consolidate the 14× repeated "edit this JSON file" README steps behind a
 * single command (the manual steps stay documented — see below):
 *
 *   $ context-mode setup            # auto-detect, write hooks + MCP registration
 *   $ context-mode setup --check    # dry-run, exit 1 if changes would apply
 *   $ context-mode setup gemini-cli # force a specific platform
 *
 * setup AUTOMATES the per-platform manual steps — it writes the same artifacts a
 * user would add by hand; the manual per-platform docs stay in the README (both
 * paths are supported). setup is NOT a replacement for `context-mode upgrade`:
 * `upgrade` (src/cli.ts) pulls latest code + rebuilds, THEN reuses this file's
 * `refreshPlatformInstall` / `refreshMcpRegistration` to refresh registration.
 * Only that registration-WRITE logic is shared (one source of truth); the two
 * commands stay distinct — do not conflate or merge them.
 *
 * Per-platform behavior (MVP — see docs/setup-improvements.md A1):
 *
 *   json-stdio platforms (gemini-cli, vscode-copilot, cursor, qwen-code, kiro):
 *     1. Hooks  → adapter.configureAllHooks(pluginRoot)  (existing path)
 *     2. MCP    → idempotent merge into the platform's mcp/servers JSON
 *
 *   native plugin / extension platforms (opencode, kilo, openclaw, pi, omp):
 *     apply the platform's config or extension wrapper automatically.
 *
 *   UI-only MCP (jetbrains-copilot): write hooks automatically, then print
 *     the exact MCP Settings UI step we cannot inspect/write safely.
 *
 *   TOML (codex): print the manual snippet — deferred until we wire a parser.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import * as p from "@clack/prompts";
import color from "picocolors";

import { detectPlatform, getAdapter } from "./adapters/detect.js";
import { REGISTERED_PLATFORM_IDS } from "./adapters/registry.js";
import { antigravityMcpConfigPath } from "./adapters/antigravity/index.js";
import { openclawConfigPath } from "./adapters/openclaw/index.js";
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

function readPackageVersion(pluginRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(pluginRoot, "package.json"), "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function fileText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function writeTextIfChanged(
  path: string,
  desired: string,
  opts: { check: boolean; label: string },
): { changed: boolean; desc: string } {
  const current = fileText(path);
  if (current === desired) {
    return { changed: false, desc: `${opts.label}: up-to-date` };
  }
  if (opts.check) {
    return { changed: true, desc: `${opts.label}: WOULD WRITE ${path}` };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, desired, "utf-8");
  return { changed: true, desc: `${opts.label}: wrote ${path}` };
}

function upsertManagedTextBlock(
  path: string,
  blockBody: string,
  opts: { check: boolean; label: string },
): { changed: boolean; desc: string } {
  const start = "<!-- context-mode:setup:start -->";
  const end = "<!-- context-mode:setup:end -->";
  const block = `${start}\n${blockBody.trimEnd()}\n${end}\n`;
  const current = fileText(path) ?? "";
  const re = new RegExp(`${start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`);
  const next = re.test(current)
    ? current.replace(re, block)
    : `${current.trimEnd()}${current.trimEnd() ? "\n\n" : ""}${block}`;
  if (current === next) {
    return { changed: false, desc: `${opts.label}: up-to-date` };
  }
  if (opts.check) {
    return { changed: true, desc: `${opts.label}: WOULD UPSERT ${path}` };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next, "utf-8");
  return { changed: true, desc: `${opts.label}: upserted ${path}` };
}

/**
 * Inverse of upsertManagedTextBlock — strip the context-mode managed block
 * (and its surrounding blank line) from `path`, preserving any user-authored
 * prose. If the managed block was the entire file, delete the file. Used by
 * uninstall so a platform's SYSTEM.md/instruction file does not keep ~4KB of
 * routing rules referencing removed ctx_* tools.
 */
function removeManagedTextBlock(
  path: string,
  opts: { check: boolean; label: string },
): { changed: boolean; desc: string } {
  const start = "<!-- context-mode:setup:start -->";
  const end = "<!-- context-mode:setup:end -->";
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const current = fileText(path);
  const re = new RegExp(`${esc(start)}[\\s\\S]*?${esc(end)}`);
  if (current === null || !re.test(current)) {
    return { changed: false, desc: `${opts.label}: not present` };
  }
  if (opts.check) {
    return { changed: true, desc: `${opts.label}: WOULD REMOVE block from ${path}` };
  }
  const next = current.replace(re, "").replace(/\n{3,}/g, "\n\n").trimEnd();
  if (next === "") {
    rmSync(path, { force: true });
    return { changed: true, desc: `${opts.label}: removed ${path} (managed block was the whole file)` };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next + "\n", "utf-8");
  return { changed: true, desc: `${opts.label}: removed block from ${path}` };
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
    // Antigravity loads its global MCP config from ~/.gemini/antigravity/
    // mcp_config.json — shared with AntigravityAdapter.getSettingsPath so
    // setup writes where doctor + the Antigravity Editor read.
    resolvePath: () => antigravityMcpConfigPath(),
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
  "omp": {
    label: "OMP agent mcp.json mcpServers",
    resolvePath: () =>
      resolve(process.env.PI_CODING_AGENT_DIR ?? resolve(homedir(), ".omp", "agent"), "mcp.json"),
    containerKey: "mcpServers",
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
  // NOTE: codex is intentionally NOT here. It is HOOK_CAPABLE with a real
  // configureAllHooks (writes ~/.codex/hooks.json + enables the feature
  // flag), so it must flow through the hooks path rather than short-circuit.
  // Its MCP registration is TOML (no MCP_REGISTRATIONS entry); see
  // POST_SETUP_NOTES["codex"] for the TOML snippet printed after hooks run.
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
  "jetbrains-copilot":
    "JetBrains Copilot hooks were written to `.github/hooks/context-mode.json`.\n\nMCP registration still lives behind JetBrains' GitHub Copilot UI:\n  GitHub Copilot icon > Edit Settings > Model Context Protocol > Configure\n\nUse a top-level `servers` object:\n  { \"servers\": { \"context-mode\": { \"command\": \"context-mode\" } } }",
  "openclaw":
    "OpenClaw config was registered (plugins.entries + plugins.allow + mcp.servers.context-mode) in the gateway's config file.\n\nFor the gateway to LOAD context-mode it also needs the plugin module on disk and a reload — run:\n\n  npm run install:openclaw\n\nwhich lays down <state-dir>/extensions/context-mode/ and restarts the gateway. context-mode does NOT install or restart the OpenClaw gateway itself; it only registers into an already-installed gateway.",
};

/* ─────────── Hook configuration via adapter.configureAllHooks ─────────── */

const HOOK_CAPABLE: ReadonlySet<PlatformId> = new Set([
  "claude-code", "gemini-cli", "vscode-copilot", "cursor", "qwen-code",
  "kiro", "codex", // codex has its own hooks.json path
  "jetbrains-copilot", "opencode", "kilo", "openclaw",
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

function piExtensionDir(): string {
  return resolve(homedir(), ".pi", "agent", "extensions", "context-mode");
}

function ompAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? resolve(homedir(), ".omp", "agent");
}

function extensionPackageJson(
  platform: Extract<PlatformId, "pi" | "omp">,
  pluginRoot: string,
): string {
  const version = readPackageVersion(pluginRoot);
  const manifestKey = platform === "pi" ? "pi" : "omp";
  return JSON.stringify({
    name: "context-mode",
    version,
    description: `Context-mode ${platform.toUpperCase()} extension`,
    type: "module",
    main: "index.js",
    [manifestKey]: {
      extensions: ["./index.js"],
    },
  }, null, 2) + "\n";
}

function extensionEntrypoint(pluginRoot: string, buildEntry: string): string {
  return `export { default } from ${JSON.stringify(pathToFileURL(resolve(pluginRoot, buildEntry)).href)};\n`;
}

function applyPlatformInstall(
  platform: PlatformId,
  opts: { pluginRoot: string; check: boolean; projectDir?: string },
): { changed: boolean; desc: string } | null {
  const desc: string[] = [];
  let changed = false;
  const add = (result: { changed: boolean; desc: string }) => {
    changed = changed || result.changed;
    desc.push(result.desc);
  };

  if (platform === "pi") {
    const dir = piExtensionDir();
    add(writeTextIfChanged(
      resolve(dir, "package.json"),
      extensionPackageJson("pi", opts.pluginRoot),
      { check: opts.check, label: "Pi extension package" },
    ));
    add(writeTextIfChanged(
      resolve(dir, "index.js"),
      extensionEntrypoint(opts.pluginRoot, "build/adapters/pi/extension.js"),
      { check: opts.check, label: "Pi extension entrypoint" },
    ));
    return { changed, desc: `Pi extension: ${desc.join("; ")}` };
  }

  if (platform === "omp") {
    const agentDir = ompAgentDir();
    const extDir = resolve(agentDir, "extensions", "context-mode");
    add(writeTextIfChanged(
      resolve(extDir, "package.json"),
      extensionPackageJson("omp", opts.pluginRoot),
      { check: opts.check, label: "OMP extension package" },
    ));
    add(writeTextIfChanged(
      resolve(extDir, "index.js"),
      extensionEntrypoint(opts.pluginRoot, "build/adapters/omp/plugin.js"),
      { check: opts.check, label: "OMP extension entrypoint" },
    ));
    const rules = fileText(resolve(opts.pluginRoot, "configs", "omp", "SYSTEM.md"))
      ?? "# context-mode\n\nUse context-mode MCP tools for data-heavy operations.\n";
    add(upsertManagedTextBlock(
      resolve(agentDir, "SYSTEM.md"),
      rules,
      { check: opts.check, label: "OMP SYSTEM.md rules" },
    ));
    return { changed, desc: `OMP integration: ${desc.join("; ")}` };
  }

  if (platform === "cursor") {
    // Cursor's hooks cannot inject routing context — additional_context is
    // accepted but NOT surfaced to the model (Cursor upstream bug, see
    // docs/platform-support.md) — so the .cursor/rules/*.mdc rule is the
    // primary proactive-routing mechanism. The marketplace-plugin path ships
    // it (.cursor-plugin/plugin.json "rules"), but `setup cursor` must install
    // it too, or routing silently degrades to deny/ask-only. Cursor loads .mdc
    // ONLY from .cursor/rules/ (cursor.com/docs/rules), project-scoped.
    const projectDir = opts.projectDir ?? process.cwd();
    const mdc = fileText(resolve(opts.pluginRoot, "configs", "cursor", "context-mode.mdc"));
    if (mdc === null) return null;
    add(writeTextIfChanged(
      resolve(projectDir, ".cursor", "rules", "context-mode.mdc"),
      mdc,
      { check: opts.check, label: "Cursor routing rule (.cursor/rules/context-mode.mdc)" },
    ));
    return { changed, desc: `Cursor rules: ${desc.join("; ")}` };
  }

  return null;
}

export function refreshPlatformInstall(
  platform: PlatformId,
  opts: { pluginRoot: string; check?: boolean; projectDir?: string },
): { changed: boolean; desc: string } | null {
  return applyPlatformInstall(platform, {
    pluginRoot: opts.pluginRoot,
    check: opts.check ?? false,
    projectDir: opts.projectDir,
  });
}

function removePlatformInstall(
  platform: PlatformId,
  opts: { check: boolean; projectDir?: string },
): { changed: boolean; desc: string } | null {
  if (platform === "cursor") {
    // Inverse of the cursor branch in applyPlatformInstall.
    const projectDir = opts.projectDir ?? process.cwd();
    const mdc = resolve(projectDir, ".cursor", "rules", "context-mode.mdc");
    if (!existsSync(mdc)) {
      return { changed: false, desc: "Cursor routing rule: not installed" };
    }
    if (opts.check) {
      return { changed: true, desc: `Cursor routing rule: WOULD REMOVE ${mdc}` };
    }
    rmSync(mdc, { force: true });
    return { changed: true, desc: `Cursor routing rule: removed ${mdc}` };
  }

  if (platform !== "pi" && platform !== "omp") return null;
  const desc: string[] = [];
  let changed = false;
  const dir = platform === "pi"
    ? piExtensionDir()
    : resolve(ompAgentDir(), "extensions", "context-mode");
  if (existsSync(dir)) {
    if (opts.check) {
      desc.push(`WOULD REMOVE ${dir}`);
    } else {
      rmSync(dir, { recursive: true, force: true });
      desc.push(`removed ${dir}`);
    }
    changed = true;
  } else {
    desc.push("extension not installed");
  }
  // omp also injects a managed block into ~/.omp/agent/SYSTEM.md (see the omp
  // branch of applyPlatformInstall) — strip it so uninstall is symmetric.
  if (platform === "omp") {
    const sys = removeManagedTextBlock(
      resolve(ompAgentDir(), "SYSTEM.md"),
      { check: opts.check, label: "OMP SYSTEM.md rules" },
    );
    changed = changed || sys.changed;
    desc.push(sys.desc);
  }
  return { changed, desc: `${platform} extension: ${desc.join("; ")}` };
}

interface FileSnapshot {
  path: string;
  existed: boolean;
  content?: Buffer;
  nearestExistingDir: string;
}

function nearestExistingDir(path: string): string {
  let current = dirname(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function snapshotFiles(paths: string[]): FileSnapshot[] {
  return [...new Set(paths)].map((path) => ({
    path,
    existed: existsSync(path),
    content: existsSync(path) ? readFileSync(path) : undefined,
    nearestExistingDir: nearestExistingDir(path),
  }));
}

function pruneEmptyCreatedDirs(fromDir: string, stopDir: string): void {
  let current = fromDir;
  while (current !== stopDir && dirname(current) !== current) {
    try {
      rmdirSync(current);
    } catch {
      break;
    }
    current = dirname(current);
  }
}

function restoreSnapshots(snapshots: FileSnapshot[]): void {
  for (const snap of snapshots) {
    if (snap.existed) {
      mkdirSync(dirname(snap.path), { recursive: true });
      writeFileSync(snap.path, snap.content ?? Buffer.from(""));
    } else if (existsSync(snap.path)) {
      rmSync(snap.path, { force: true });
      pruneEmptyCreatedDirs(dirname(snap.path), snap.nearestExistingDir);
    }
  }
}

function hookConfigPaths(platform: PlatformId, projectDir: string): string[] {
  const xdgRoot = process.platform === "win32"
    ? (process.env.APPDATA || resolve(homedir(), "AppData", "Roaming"))
    : (process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"));
  switch (platform) {
    case "opencode":
      return [
        resolve(projectDir, "opencode.json"),
        resolve(projectDir, "opencode.jsonc"),
        resolve(projectDir, ".opencode", "opencode.json"),
        resolve(projectDir, ".opencode", "opencode.jsonc"),
        resolve(xdgRoot, "opencode", "opencode.json"),
        resolve(xdgRoot, "opencode", "opencode.jsonc"),
      ];
    case "kilo":
      return [
        resolve(projectDir, "kilo.json"),
        resolve(projectDir, "kilo.jsonc"),
        resolve(projectDir, ".kilo", "kilo.json"),
        resolve(projectDir, ".kilo", "kilo.jsonc"),
        resolve(projectDir, ".kilocode", "kilo.json"),
        resolve(projectDir, ".kilocode", "kilo.jsonc"),
        resolve(xdgRoot, "kilo", "kilo.json"),
        resolve(xdgRoot, "kilo", "kilo.jsonc"),
      ];
    case "openclaw":
      // Lead with the gateway's real config path (env / state-dir / ~/.openclaw)
      // so the --check dry-run snapshots the file setup actually writes.
      return [
        openclawConfigPath(),
        resolve(projectDir, "openclaw.json"),
        resolve(projectDir, ".openclaw", "openclaw.json"),
        resolve(homedir(), ".openclaw", "openclaw.json"),
      ];
    case "kiro":
      return [
        resolve(homedir(), ".kiro", "agents", "kiro_default.json"),
      ];
    case "codex":
      return [
        resolve(homedir(), ".codex", "config.toml"),
        resolve(homedir(), ".codex", "hooks.json"),
      ];
    case "vscode-copilot":
    case "jetbrains-copilot":
      return [resolve(projectDir, ".github", "hooks", "context-mode.json")];
    default:
      return [];
  }
}

async function applyHooksViaAdapter(
  platform: PlatformId,
  pluginRoot: string,
  check: boolean,
  projectDir: string,
): Promise<{ changed: boolean; desc: string }> {
  if (!HOOK_CAPABLE.has(platform)) {
    return { changed: false, desc: "Hooks: not applicable for this platform" };
  }
  if (check) {
    const adapter = await getAdapter(platform);
    const paths = [
      adapter.getSettingsPath(),
      ...hookConfigPaths(platform, projectDir),
    ];
    const snapshots = snapshotFiles(paths);
    try {
      const changes = adapter.configureAllHooks(pluginRoot);
      const changed = changes.length > 0;
      return changed
        ? { changed: true, desc: `Hooks: WOULD WRITE ${changes.join("; ")}` }
        : { changed: false, desc: "Hooks: up-to-date" };
    } finally {
      restoreSnapshots(snapshots);
    }
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
      const installRemoval = removePlatformInstall(platform, { check: !!opts.check, projectDir });
      if (installRemoval) {
        if (installRemoval.changed) {
          if (opts.check) driftSeen = true;
          else outcome = "applied";
          p.log.success(color.green(installRemoval.desc));
          changes.push(installRemoval.desc);
        } else {
          p.log.info(color.dim(installRemoval.desc));
          changes.push(installRemoval.desc);
        }
      }

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

    // ── Plugin/config entry removal — inverse of configureAllHooks ──
    // opencode/kilo register context-mode INTO the host's `plugin` array;
    // openclaw into plugins.entries + plugins.allow + slots + mcp.servers.
    // Without removing these, --uninstall was a silent no-op and the host kept
    // loading context-mode while setup reported "Already uninstalled". Adapters
    // expose the inverse via the optional unconfigureHooks(). (Loop-5 finding.)
    let hookEntriesHandled = false;
    if (HOOK_CAPABLE.has(platform)) {
      try {
        const adapter = await getAdapter(platform);
        if (typeof adapter.unconfigureHooks === "function") {
          hookEntriesHandled = true;
          if (opts.check) {
            const paths = [adapter.getSettingsPath(), ...hookConfigPaths(platform, projectDir)];
            const snapshots = snapshotFiles(paths);
            try {
              const removed = adapter.unconfigureHooks(opts.pluginRoot);
              if (removed.length > 0) {
                driftSeen = true;
                p.log.success(color.green(`Hooks: WOULD REMOVE — ${removed.join("; ")}`));
                changes.push(...removed);
              } else {
                p.log.info(color.dim("Hook/plugin entries: none found"));
              }
            } finally {
              restoreSnapshots(snapshots);
            }
          } else {
            const removed = adapter.unconfigureHooks(opts.pluginRoot);
            if (removed.length > 0) {
              outcome = "applied";
              p.log.success(color.green(`Hooks: ${removed.join("; ")}`));
              changes.push(...removed);
            } else {
              p.log.info(color.dim("Hook/plugin entries: none found"));
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        p.log.error(color.red(`Hook removal: FAIL — ${msg}`));
        warnings.push(`uninstall hooks: ${msg}`);
        hadFailure = true;
      }
    }

    // For the json-stdio hook platforms (gemini/cursor/copilot/kiro/codex) the
    // hook entries live in config files we do not auto-remove yet, so point the
    // user at manual removal. Platforms whose registration we DID invert above
    // (opencode/kilo/openclaw) are fully removed — skip the misleading note.
    if (!hookEntriesHandled) {
      p.log.info(
        color.dim("Hook entries (if any) left in place — remove manually from your platform's hooks.json."),
      );
    }
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
      p.outro(color.green("Uninstall complete — context-mode registration removed."));
    } else {
      p.outro(color.green("Already uninstalled — nothing to do."));
    }
    return 0;
  }

  // ── 0. Platform package/extension install (Pi/OMP) ──
  try {
    const platformInstall = applyPlatformInstall(platform, {
      pluginRoot: opts.pluginRoot,
      check: !!opts.check,
      projectDir,
    });
    if (platformInstall) {
      if (platformInstall.changed) {
        if (opts.check) driftSeen = true;
        else outcome = "applied";
        p.log.success(color.green(platformInstall.desc));
      } else {
        p.log.info(color.dim(platformInstall.desc));
      }
      changes.push(platformInstall.desc);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    p.log.error(color.red(`Platform install: FAIL — ${msg}`));
    warnings.push(`platform install: ${msg}`);
    hadFailure = true;
  }

  // ── 1. Hooks (adapter.configureAllHooks) ──
  try {
    const hookResult = await applyHooksViaAdapter(platform, opts.pluginRoot, !!opts.check, projectDir);
    if (opts.check) {
      if (hookResult.changed) {
        driftSeen = true;
        p.log.success(color.green(hookResult.desc));
      } else {
        p.log.info(color.dim(hookResult.desc));
      }
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
    p.outro(color.green("No setup drift."));
    return 0;
  }
  if (outcome === "applied") {
    p.outro(color.green("Setup complete. Run `context-mode doctor` to verify."));
  } else {
    p.outro(color.green("Already configured — nothing to do."));
  }
  return 0;
}
