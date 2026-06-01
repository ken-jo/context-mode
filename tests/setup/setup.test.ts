/**
 * End-to-end coverage for `context-mode setup` (Item A6).
 *
 * Spawns the CLI in a subprocess against an isolated `$HOME` so each test
 * exercises the real merge path that ships to users — `applyMcpRegistration`
 * resolves home-scoped paths via `homedir()`, which can't be patched
 * cleanly from an in-process import.
 *
 * Matrix:
 *   - Per-platform: setup writes the right file at the right key
 *   - User-key preservation: a sibling mcpServers entry survives setup + uninstall
 *   - --check exit codes: 0 when up-to-date, 1 when drift exists
 *   - --uninstall round-trip: setup → uninstall → setup is idempotent
 *
 * Spawn pattern mirrors `tests/util/postinstall-heal.test.ts`.
 */

import { afterEach, describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const REPO_CLI = resolve(REPO_ROOT, "src", "cli.ts");
const TSX_LOADER = resolve(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs");

/** Track temp dirs so afterEach can clean them up. */
let _tmps: string[] = [];
function mkTmp(prefix = "ctx-setup-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  _tmps.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of _tmps) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  _tmps = [];
});

/** Spawn `tsx src/cli.ts setup …` in an isolated HOME + cwd. */
function runSetup(opts: {
  home: string;
  cwd?: string;
  args: string[];
  platform: string;
}): { stdout: string; stderr: string; status: number | null } {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: opts.home,
    USERPROFILE: opts.home,
    CONTEXT_MODE_PLATFORM: opts.platform,
    // Silence npm telemetry chatter in test output.
    npm_config_update_notifier: "false",
    // Force a stable cwd unless the test overrides it.
    NODE_NO_WARNINGS: "1",
  };
  if (process.platform === "win32") {
    env.LOCALAPPDATA = resolve(opts.home, "AppData", "Local");
    env.APPDATA = resolve(opts.home, "AppData", "Roaming");
  }
  const r = spawnSync(
    process.execPath,
    ["--import", TSX_LOADER, REPO_CLI, "setup", ...opts.args],
    {
      cwd: opts.cwd ?? opts.home,
      env,
      encoding: "utf-8",
      timeout: 30_000,
    },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

/**
 * Standard per-platform target path resolver — MUST mirror setup.ts
 * MCP_REGISTRATIONS at the DEFAULT scope. kiro + antigravity were corrected
 * to user-home defaults so setup writes the same file the adapter's
 * checkPluginRegistration() (doctor) reads — verified by the official-source
 * workflow (see docs/setup-improvements.md "Workflow verification findings").
 *   - antigravity: ~/.gemini/antigravity/mcp_config.json by default
 *     (or antigravity-cli when ANTIGRAVITY_CLI_ALIAS is set), home;
 *     mcp_config.json, NOT mcp.json — matches AntigravityAdapter.getConfigDir.
 *   - kiro: ~/.kiro/settings/mcp.json (home default) — matches
 *     KiroAdapter.getSettingsPath.
 */
function expectedTargetPath(platform: string, home: string, cwd: string): string {
  switch (platform) {
    case "gemini-cli":   return resolve(home, ".gemini", "settings.json");
    case "vscode-copilot": return resolve(cwd, ".vscode", "mcp.json");
    case "cursor":       return resolve(cwd, ".cursor", "mcp.json");
    case "qwen-code":    return resolve(home, ".qwen", "settings.json");
    case "kiro":         return resolve(home, ".kiro", "settings", "mcp.json");
    case "antigravity":  return resolve(home, ".gemini", "antigravity", "mcp_config.json");
    case "zed":
      return process.platform === "win32"
        ? resolve(home, "AppData", "Local", "Zed", "settings.json")
        : resolve(home, ".config", "zed", "settings.json");
    default: throw new Error(`unknown platform ${platform}`);
  }
}

// kiro + antigravity moved to HOME_SCOPED — their default scope is now user
// (the file doctor reads). vscode-copilot + cursor remain genuinely
// project-canonical.
const HOME_SCOPED = ["gemini-cli", "qwen-code", "zed", "kiro", "antigravity"] as const;
const PROJECT_SCOPED = ["vscode-copilot", "cursor"] as const;
const ALL_JSON_STDIO = [...HOME_SCOPED, ...PROJECT_SCOPED];

// ── setup↔doctor path agreement (regression guard for the workflow finding) ──
// The official-source verification workflow found setup.ts wrote MCP files
// that the platform adapter's checkPluginRegistration() (doctor) never reads
// — antigravity (.antigravity/mcp.json vs ~/.gemini/antigravity/mcp_config.json)
// and kiro (project vs ~/.kiro/settings/mcp.json). This asserts the adapter's
// READ path equals the test's mirror of setup's DEFAULT WRITE path; combined
// with the matrix test below (which proves setup actually writes to
// expectedTargetPath), the chain proves setup writes where doctor reads.
describe("setup↔doctor path agreement", () => {
  test("antigravity: adapter read path == setup default write path", async () => {
    const { AntigravityAdapter } = await import("../../src/adapters/antigravity/index.js");
    const real = (await import("node:os")).homedir();
    expect(new AntigravityAdapter().getSettingsPath()).toBe(
      expectedTargetPath("antigravity", real, process.cwd()),
    );
  });

  test("kiro: adapter read path == setup default (user) write path", async () => {
    const { KiroAdapter } = await import("../../src/adapters/kiro/index.js");
    const real = (await import("node:os")).homedir();
    expect(new KiroAdapter().getSettingsPath()).toBe(
      expectedTargetPath("kiro", real, process.cwd()),
    );
  });

  test("gemini-cli: adapter settings path == setup write path", async () => {
    const { GeminiCLIAdapter } = await import("../../src/adapters/gemini-cli/index.js");
    const real = (await import("node:os")).homedir();
    expect(new GeminiCLIAdapter().getSettingsPath()).toBe(
      expectedTargetPath("gemini-cli", real, process.cwd()),
    );
  });
});

// ── setup↔doctor KEY agreement (second-pass finding) ──
// The path-agreement tests above only proved the FILE matches — they missed
// that gemini-cli's doctor read the wrong container KEY (it inspected
// `extensions`, never the `mcpServers` setup writes), so doctor WARNed after
// a clean setup. These tests write exactly what setup writes (the right
// container key + server shape) to the adapter's read path under a patched
// $HOME, then call checkPluginRegistration() and assert PASS — closing the
// triangle at the KEY level, in-process (no spawn).
describe("setup↔doctor KEY agreement (checkPluginRegistration passes on setup output)", () => {
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUserProfile;
  });

  function withHome(home: string) {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  }

  test("gemini-cli: doctor PASSES when setup wrote mcpServers (not extensions)", async () => {
    const home = mkTmp("ctx-key-gemini-");
    withHome(home);
    // Exactly what setup writes for gemini.
    const p = resolve(home, ".gemini", "settings.json");
    mkdirSync(resolve(home, ".gemini"), { recursive: true });
    writeFileSync(p, JSON.stringify({ mcpServers: { "context-mode": { command: "context-mode" } } }));
    const { GeminiCLIAdapter } = await import("../../src/adapters/gemini-cli/index.js");
    const result = new GeminiCLIAdapter().checkPluginRegistration();
    expect(result.status).toBe("pass");
  });

  test("vscode-copilot: doctor PASSES on the ~/.vscode/mcp.json that --scope user writes", async () => {
    const home = mkTmp("ctx-key-vscode-");
    withHome(home);
    // No project .vscode/mcp.json in cwd; only the user-home file (the
    // --scope user target). The home fallback must find it.
    const p = resolve(home, ".vscode", "mcp.json");
    mkdirSync(resolve(home, ".vscode"), { recursive: true });
    writeFileSync(p, JSON.stringify({ servers: { "context-mode": { command: "context-mode" } } }));
    const { VSCodeCopilotAdapter } = await import("../../src/adapters/vscode-copilot/index.js");
    const result = new VSCodeCopilotAdapter().checkPluginRegistration();
    expect(result.status).toBe("pass");
  });
});

describe("setup matrix — write per platform", () => {
  for (const platform of ALL_JSON_STDIO) {
    test(`${platform}: writes mcpServers context-mode entry`, () => {
      const home = mkTmp(`ctx-setup-${platform}-`);
      const r = runSetup({ home, args: [], platform });
      expect(r.status === 0 || r.status === null).toBe(true);
      const target = expectedTargetPath(platform, home, home);
      expect(existsSync(target), `expected ${target} to exist`).toBe(true);
      const parsed = JSON.parse(readFileSync(target, "utf-8"));
      const containerKey = platform === "vscode-copilot" ? "servers"
        : platform === "zed" ? "context_servers"
        : "mcpServers";
      expect(parsed[containerKey]).toBeDefined();
      expect(parsed[containerKey]["context-mode"]).toBeDefined();
      // Loop-1 regression: Zed's context_servers entry must be FLAT —
      // `command` is a STRING ("context-mode"), not the nested
      // `{ path, args }` object that current Zed rejects (server fails to load).
      if (platform === "zed") {
        expect(typeof parsed.context_servers["context-mode"].command).toBe("string");
        expect(parsed.context_servers["context-mode"].command).toBe("context-mode");
      }
    });
  }
});

describe("setup --check", () => {
  test("noop on fresh re-apply for gemini-cli (mcp is up-to-date)", () => {
    const home = mkTmp("ctx-setup-check-");
    runSetup({ home, args: [], platform: "gemini-cli" });
    const r = runSetup({ home, args: ["--check"], platform: "gemini-cli" });
    expect(r.stdout + r.stderr).toMatch(/up-to-date/);
    expect(r.status).toBe(0);
  });

  test("reports WOULD WRITE on a virgin HOME for gemini-cli", () => {
    const home = mkTmp("ctx-setup-check-virgin-");
    const r = runSetup({ home, args: ["--check"], platform: "gemini-cli" });
    expect(r.stdout + r.stderr).toMatch(/WOULD WRITE/);
    // exit 1 = drift detected; the test harness treats non-zero as failure
    // for spawnSync.status but we want to assert THIS exit code precisely.
    expect(r.status).toBe(1);
  });

  test("reports hook drift when MCP is present but hooks are missing", () => {
    const home = mkTmp("ctx-setup-check-hooks-");
    const settingsPath = expectedTargetPath("gemini-cli", home, home);
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      mcpServers: { "context-mode": { command: "context-mode" } },
    }, null, 2));

    const r = runSetup({ home, args: ["--check"], platform: "gemini-cli" });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/Hooks: WOULD WRITE/);
  });
});

describe("setup --uninstall preserves user keys", () => {
  test("gemini-cli: removing context-mode keeps the user's sibling entry", () => {
    const home = mkTmp("ctx-setup-uninst-");
    // Step 1 — write context-mode.
    runSetup({ home, args: [], platform: "gemini-cli" });
    const target = expectedTargetPath("gemini-cli", home, home);
    expect(existsSync(target)).toBe(true);

    // Step 2 — plant a sibling user key in the same map.
    const parsed = JSON.parse(readFileSync(target, "utf-8"));
    parsed.mcpServers["my-other-server"] = { command: "foo" };
    writeFileSync(target, JSON.stringify(parsed, null, 2));

    // Step 3 — uninstall.
    const r = runSetup({ home, args: ["--uninstall"], platform: "gemini-cli" });
    expect(r.status === 0 || r.status === null).toBe(true);

    // Step 4 — context-mode gone, user key survives.
    const after = JSON.parse(readFileSync(target, "utf-8"));
    expect(after.mcpServers["context-mode"]).toBeUndefined();
    expect(after.mcpServers["my-other-server"]).toEqual({ command: "foo" });
  });

  test("--uninstall --check reports WOULD REMOVE without mutating", () => {
    const home = mkTmp("ctx-setup-uninst-check-");
    runSetup({ home, args: [], platform: "gemini-cli" });
    const target = expectedTargetPath("gemini-cli", home, home);
    const before = readFileSync(target, "utf-8");

    const r = runSetup({ home, args: ["--uninstall", "--check"], platform: "gemini-cli" });
    expect(r.stdout + r.stderr).toMatch(/WOULD REMOVE/);
    expect(r.status).toBe(1);
    // File MUST be byte-identical.
    expect(readFileSync(target, "utf-8")).toBe(before);
  });
});

describe("setup formerly manual platforms", () => {
  test("claude-code prints marketplace pointer + exit 0", () => {
    const home = mkTmp("ctx-setup-cc-");
    const r = runSetup({ home, args: [], platform: "claude-code" });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/marketplace|managed externally/i);
  });

  test("codex prints TOML snippet + exit 0", () => {
    const home = mkTmp("ctx-setup-codex-");
    const r = runSetup({ home, args: [], platform: "codex" });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/config\.toml/i);
  });

  test("jetbrains-copilot writes hook config and prints MCP UI note", () => {
    const home = mkTmp("ctx-setup-jb-");
    const cwd = mkTmp("ctx-setup-jb-proj-");
    const r = runSetup({ home, cwd, args: [], platform: "jetbrains-copilot" });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/Settings/);
    const hooksPath = resolve(cwd, ".github", "hooks", "context-mode.json");
    expect(existsSync(hooksPath)).toBe(true);
    const hooks = JSON.parse(readFileSync(hooksPath, "utf-8"));
    expect(hooks.hooks.PreToolUse[0].command).toBe("context-mode hook jetbrains-copilot pretooluse");
  });

  test("opencode writes singular plugin array", () => {
    const home = mkTmp("ctx-setup-opencode-");
    const r = runSetup({ home, args: [], platform: "opencode" });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(readFileSync(resolve(home, "opencode.json"), "utf-8"));
    expect(parsed.plugin).toContain("context-mode");
  });

  test("kilo writes singular plugin array", () => {
    const home = mkTmp("ctx-setup-kilo-");
    const r = runSetup({ home, args: [], platform: "kilo" });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(readFileSync(resolve(home, "kilo.json"), "utf-8"));
    expect(parsed.plugin).toContain("context-mode");
  });

  test("openclaw writes plugin entry plus MCP sidecar", () => {
    const home = mkTmp("ctx-setup-openclaw-home-");
    const cwd = mkTmp("ctx-setup-openclaw-proj-");
    const r = runSetup({ home, cwd, args: [], platform: "openclaw" });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(readFileSync(resolve(cwd, "openclaw.json"), "utf-8"));
    expect(parsed.plugins.entries["context-mode"]).toBeDefined();
    expect(parsed.mcp.servers["context-mode"].command).toBe("node");
  });

  test("pi installs extension wrapper", () => {
    const home = mkTmp("ctx-setup-pi-");
    const r = runSetup({ home, args: [], platform: "pi" });
    expect(r.status).toBe(0);
    const pkg = JSON.parse(readFileSync(resolve(home, ".pi", "agent", "extensions", "context-mode", "package.json"), "utf-8"));
    expect(pkg.name).toBe("context-mode");
    expect(existsSync(resolve(home, ".pi", "agent", "extensions", "context-mode", "index.js"))).toBe(true);
  });

  test("omp writes MCP registration, extension wrapper, and managed SYSTEM.md block", () => {
    const home = mkTmp("ctx-setup-omp-");
    const r = runSetup({ home, args: [], platform: "omp" });
    expect(r.status).toBe(0);
    const mcp = JSON.parse(readFileSync(resolve(home, ".omp", "agent", "mcp.json"), "utf-8"));
    expect(mcp.mcpServers["context-mode"].command).toBe("context-mode");
    expect(existsSync(resolve(home, ".omp", "agent", "extensions", "context-mode", "index.js"))).toBe(true);
    expect(readFileSync(resolve(home, ".omp", "agent", "SYSTEM.md"), "utf-8")).toMatch(/context-mode:setup:start/);
  });
});

describe("setup MCP-only honesty banner (Item E2)", () => {
  test("zed setup announces best-effort fidelity", () => {
    const home = mkTmp("ctx-setup-zed-");
    const r = runSetup({ home, args: [], platform: "zed" });
    expect(r.stdout + r.stderr).toMatch(/best-effort/i);
    expect(r.stdout + r.stderr).toMatch(/60%/);
  });

  test("antigravity setup announces best-effort fidelity", () => {
    const home = mkTmp("ctx-setup-antigravity-");
    const r = runSetup({ home, args: [], platform: "antigravity" });
    expect(r.stdout + r.stderr).toMatch(/best-effort/i);
    expect(r.stdout + r.stderr).toMatch(/60%/);
  });
});
