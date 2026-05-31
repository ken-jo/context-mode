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
import type { PlatformId } from "./adapters/types.js";

export interface SetupOptions {
  /** Explicit platform; bypasses detection. */
  platform?: PlatformId;
  /** Dry-run — print would-be changes, exit 1 when drift exists. */
  check?: boolean;
  /** Re-write even when current state already matches. */
  force?: boolean;
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

function readJsonOrDefault<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
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
 * Set `obj[key] = desired` only when it differs. Returns true when a write
 * happened. Comparison is structural-by-JSON since templates are tiny and
 * deterministic.
 */
function upsertKey(obj: Record<string, unknown>, key: string, desired: unknown): boolean {
  const cur = obj[key];
  if (cur && typeof cur === "object" && JSON.stringify(cur) === JSON.stringify(desired)) {
    return false;
  }
  obj[key] = desired;
  return true;
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
    label: "Kiro mcp.json mcpServers",
    resolvePath: ({ projectDir }) => resolve(projectDir, ".kiro", "settings", "mcp.json"),
    containerKey: "mcpServers",
  },
  "antigravity": {
    label: "Antigravity mcp.json mcpServers",
    resolvePath: ({ projectDir }) => resolve(projectDir, ".antigravity", "mcp.json"),
    containerKey: "mcpServers",
  },
  "zed": {
    label: "Zed settings.json context_servers",
    resolvePath: () => resolve(homedir(), ".config", "zed", "settings.json"),
    containerKey: "context_servers",
    serverKey: SERVER_KEY,
    // Zed context_servers entries use a slightly different shape.
    desired: { command: { path: "context-mode", args: [] } },
  },
};

function applyMcpRegistration(
  platform: PlatformId,
  opts: { check: boolean; scope: "user" | "project"; projectDir: string },
): { changed: boolean; path?: string; desc: string } | null {
  const handler = MCP_REGISTRATIONS[platform];
  if (!handler) return null;
  const path = handler.resolvePath({ scope: opts.scope, projectDir: opts.projectDir });
  const container = handler.containerKey;
  const sub = handler.serverKey ?? SERVER_KEY;
  const desired = handler.desired ?? DESIRED_SERVER;

  const root = readJsonOrDefault<Record<string, unknown>>(path, {});
  const servers = (root[container] && typeof root[container] === "object"
    ? (root[container] as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const wouldChange = JSON.stringify(servers[sub]) !== JSON.stringify(desired);
  if (!wouldChange) {
    return { changed: false, path, desc: `${handler.label}: up-to-date` };
  }
  if (opts.check) {
    return { changed: true, path, desc: `${handler.label}: WOULD WRITE` };
  }
  upsertKey(servers, sub, desired);
  root[container] = servers;
  writeJsonAtomic(path, root);
  return { changed: true, path, desc: `${handler.label}: wrote ${sub}` };
}

/* ─────────── External/manual platform messages ─────────── */

const MANUAL_HINTS: Partial<Record<PlatformId, string>> = {
  "claude-code":
    "Installed via Claude Code marketplace. Run `/plugin install context-mode@context-mode` inside Claude Code.",
  "opencode":
    "OpenCode auto-installs the plugin from npm into ~/.cache/opencode/packages/... Add `\"context-mode\"` to plugins in ~/.config/opencode/config.json.",
  "kilo":
    "KiloCode auto-installs from npm into its package cache. Add `\"context-mode\"` to plugins in your KiloCode config.",
  "openclaw":
    "OpenClaw uses a native gateway plugin. Run `npm run install:openclaw` from the plugin root.",
  "pi":
    "Pi installs as an extension at ~/.pi/extensions/context-mode/. The npm postinstall step normally handles this when installed globally.",
  "omp":
    "OMP installs as a plugin via the npm package. The Pi runtime picks it up at ~/.omp/.",
  "codex":
    "Codex uses TOML. Add this to ~/.codex/config.toml:\n\n  [mcp_servers.context-mode]\n  command = \"context-mode\"\n\n(Automated TOML editing is on the roadmap — see docs/setup-improvements.md A1.)",
  "jetbrains-copilot":
    "JetBrains adds MCP via Settings UI:\n    Settings > Tools > AI Assistant > Model Context Protocol > Add Server\n      Name:    context-mode\n      Command: context-mode\n  Then drop `.github/hooks/context-mode.json` (see configs/jetbrains-copilot/hooks.json).",
};

/* ─────────── Hook configuration via adapter.configureAllHooks ─────────── */

const HOOK_CAPABLE: ReadonlySet<PlatformId> = new Set([
  "claude-code", "gemini-cli", "vscode-copilot", "cursor", "qwen-code",
  "kiro", "codex", // codex has its own hooks.json path
]);

async function applyHooksViaAdapter(
  platform: PlatformId,
  pluginRoot: string,
  check: boolean,
): Promise<{ changed: boolean; desc: string }> {
  if (!HOOK_CAPABLE.has(platform)) {
    return { changed: false, desc: "Hooks: not applicable for this platform" };
  }
  // configureAllHooks is destructive. For --check we shortcut: report a
  // single line and let the user re-run without --check. A real diff would
  // require running configureAllHooks in a temp-file mode that no adapter
  // currently exposes — out of scope for the MVP.
  if (check) {
    return { changed: true, desc: "Hooks: WOULD CONFIGURE (re-run without --check to apply)" };
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

  // Default scope: vscode-copilot and cursor are project-first because their
  // canonical install path is per-project. Others are user-scoped.
  const scope: "user" | "project" =
    opts.scope ?? (platform === "vscode-copilot" || platform === "cursor" || platform === "kiro" || platform === "antigravity"
      ? "project"
      : "user");

  const changes: string[] = [];
  const warnings: string[] = [];
  let driftSeen = false;
  let outcome: SetupOutcome = "noop";

  // ── External / manual platforms ──
  const manual = MANUAL_HINTS[platform];
  if (manual) {
    p.log.warn(color.yellow("Setup is managed externally for this platform."));
    p.note(manual, platform);
    outcome = "manual";
    p.outro(color.dim("No files written. See docs/setup-improvements.md for automation roadmap."));
    return 0;
  }

  // ── 1. Hooks (adapter.configureAllHooks) ──
  try {
    const hookResult = await applyHooksViaAdapter(platform, opts.pluginRoot, !!opts.check);
    if (hookResult.changed) {
      if (opts.check) driftSeen = true;
      else outcome = "applied";
      p.log.success(color.green(hookResult.desc));
    } else {
      p.log.info(color.dim(hookResult.desc));
    }
    changes.push(hookResult.desc);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    p.log.error(color.red(`Hooks: FAIL — ${msg}`));
    warnings.push(`hooks: ${msg}`);
  }

  // ── 2. MCP server registration ──
  try {
    const mcpResult = applyMcpRegistration(platform, {
      check: !!opts.check,
      scope,
      projectDir,
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
  }

  // ── 3. Outcome ──
  if (opts.check && driftSeen) {
    outcome = "drift";
    p.outro(color.yellow("Drift detected — re-run without --check to apply."));
    return 1;
  }
  if (outcome === "applied") {
    p.outro(color.green("Setup complete. Run `context-mode doctor` to verify."));
  } else if (outcome === "noop") {
    p.outro(color.green("Already configured — nothing to do."));
  }
  // Surface the result for tests / callers.
  const _result: SetupResult = { platform, outcome, changes, warnings };
  void _result;
  return 0;
}
