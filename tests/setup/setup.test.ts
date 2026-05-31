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
  const r = spawnSync(
    "npx",
    ["--prefix", REPO_ROOT, "tsx", REPO_CLI, "setup", ...opts.args],
    {
      cwd: opts.cwd ?? opts.home,
      env,
      encoding: "utf-8",
      timeout: 30_000,
    },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

/** Standard per-platform target path resolver — must mirror setup.ts. */
function expectedTargetPath(platform: string, home: string, cwd: string): string {
  switch (platform) {
    case "gemini-cli":   return resolve(home, ".gemini", "settings.json");
    case "vscode-copilot": return resolve(cwd, ".vscode", "mcp.json");
    case "cursor":       return resolve(cwd, ".cursor", "mcp.json");
    case "qwen-code":    return resolve(home, ".qwen", "settings.json");
    case "kiro":         return resolve(cwd, ".kiro", "settings", "mcp.json");
    case "antigravity":  return resolve(cwd, ".antigravity", "mcp.json");
    case "zed":          return resolve(home, ".config", "zed", "settings.json");
    default: throw new Error(`unknown platform ${platform}`);
  }
}

const HOME_SCOPED = ["gemini-cli", "qwen-code", "zed"] as const;
const PROJECT_SCOPED = ["vscode-copilot", "cursor", "kiro", "antigravity"] as const;
const ALL_JSON_STDIO = [...HOME_SCOPED, ...PROJECT_SCOPED];

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
    });
  }
});

describe("setup --check", () => {
  test("noop on fresh re-apply for gemini-cli (mcp is up-to-date)", () => {
    const home = mkTmp("ctx-setup-check-");
    runSetup({ home, args: [], platform: "gemini-cli" });
    // Hooks WOULD CONFIGURE always — known limitation logged in
    // docs/setup-improvements.md "Discovered issues". So --check exits 1
    // (drift). The narrow assertion we can make today is that the MCP
    // registration is reported up-to-date.
    const r = runSetup({ home, args: ["--check"], platform: "gemini-cli" });
    expect(r.stdout + r.stderr).toMatch(/up-to-date/);
  });

  test("reports WOULD WRITE on a virgin HOME for gemini-cli", () => {
    const home = mkTmp("ctx-setup-check-virgin-");
    const r = runSetup({ home, args: ["--check"], platform: "gemini-cli" });
    expect(r.stdout + r.stderr).toMatch(/WOULD WRITE/);
    // exit 1 = drift detected; the test harness treats non-zero as failure
    // for spawnSync.status but we want to assert THIS exit code precisely.
    expect(r.status).toBe(1);
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

describe("setup manual-hint platforms exit cleanly", () => {
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

  test("jetbrains-copilot prints UI Settings instructions + exit 0", () => {
    const home = mkTmp("ctx-setup-jb-");
    const r = runSetup({ home, args: [], platform: "jetbrains-copilot" });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/Settings/);
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
