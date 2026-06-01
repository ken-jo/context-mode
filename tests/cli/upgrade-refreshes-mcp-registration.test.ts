/**
 * Item A7 of docs/setup-improvements.md — `context-mode upgrade` MUST
 * refresh the MCP server registration alongside hooks.
 *
 * Without this contract the upgrade flow only touches
 *   - plugin registry (`adapter.updatePluginRegistry`)
 *   - hooks       (`adapter.configureAllHooks`)
 *   - permissions (`adapter.setHookPermissions`)
 * leaving any stale or never-written `.cursor/mcp.json` /
 * `~/.gemini/settings.json` mcpServers entry untouched. Users hit
 * /ctx-upgrade, get "Upgrade complete" + green doctor, and still cannot
 * call MCP tools because the server registration was never refreshed.
 *
 * Static-analysis guard — same pattern as the other tests/cli/upgrade-*.ts
 * files. Spawning end-to-end upgrade is out of scope (it pulls from the
 * marketplace), but asserting the wiring exists in source catches the
 * regression at PR time.
 */

import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const REPO_CLI = resolve(REPO_ROOT, "src", "cli.ts");
const REPO_SETUP = resolve(REPO_ROOT, "src", "setup.ts");

const cliSrc = readFileSync(REPO_CLI, "utf-8");
const setupSrc = readFileSync(REPO_SETUP, "utf-8");

describe("upgrade refreshes MCP server registration (Item A7)", () => {
  test("setup.ts exports refreshMcpRegistration", () => {
    expect(setupSrc).toMatch(/export\s+function\s+refreshMcpRegistration/);
  });

  test("cli.ts upgrade() imports refreshMcpRegistration from ./setup", () => {
    // Dynamic import is fine — the upgrade hot path tolerates an extra
    // microtask. What matters is that the symbol is referenced AT ALL.
    expect(cliSrc).toMatch(/refreshMcpRegistration/);
    // Accept either static `from "./setup.js"` or dynamic `import("./setup.js")`
    // — dynamic is preferred in the hot path to keep cli.ts startup lean.
    expect(cliSrc).toMatch(/(from|import\s*\()\s*["']\.\/setup(\.js)?["']/);
  });

  test("setup.ts exports refreshPlatformInstall for extension/plugin platforms", () => {
    expect(setupSrc).toMatch(/export\s+function\s+refreshPlatformInstall/);
  });

  test("upgrade refreshes platform install before MCP registration", () => {
    const hooksIdx = cliSrc.indexOf("adapter.configureAllHooks(");
    const installIdx = cliSrc.indexOf("refreshPlatformInstall(");
    const refreshIdx = cliSrc.indexOf("refreshMcpRegistration(");
    expect(hooksIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(hooksIdx);
    expect(refreshIdx).toBeGreaterThan(installIdx);
  });

  test("platform install refresh failure marks upgrade non-zero", () => {
    const installIdx = cliSrc.indexOf("refreshPlatformInstall(");
    const block = cliSrc.slice(installIdx, installIdx + 900);
    expect(block).toMatch(/process\.exitCode\s*=\s*1/);
    expect(block).toMatch(/Platform install refresh failed/);
  });

  test("the refresh call happens AFTER configureAllHooks", () => {
    const hooksIdx = cliSrc.indexOf("adapter.configureAllHooks(");
    const refreshIdx = cliSrc.indexOf("refreshMcpRegistration(");
    expect(hooksIdx).toBeGreaterThan(-1);
    expect(refreshIdx).toBeGreaterThan(-1);
    expect(refreshIdx).toBeGreaterThan(hooksIdx);
  });

  test("the refresh failure is wrapped — upgrade must not crash on it", () => {
    // Find the refresh call's enclosing try/catch — at minimum, the call
    // site must appear inside a try { } catch { } block so a transient
    // permission error doesn't surface as "Upgrade failed".
    const refreshIdx = cliSrc.indexOf("refreshMcpRegistration(");
    const before = cliSrc.slice(0, refreshIdx);
    const after = cliSrc.slice(refreshIdx);
    // Walk backward for the most recent `try {`, walk forward for the
    // matching `catch (` — both must exist within ~30 lines.
    const tryIdx = before.lastIndexOf("try {");
    const catchIdx = after.indexOf("} catch");
    expect(tryIdx).toBeGreaterThan(-1);
    expect(catchIdx).toBeGreaterThan(-1);
    // Sanity: the try must be within ~30 lines (rough bound).
    const linesBetween = before.slice(tryIdx).split("\n").length;
    expect(linesBetween).toBeLessThan(30);
  });

  test("refresh uses the resolved projectDir rather than pluginRoot cwd", () => {
    expect(cliSrc).toMatch(/resolveProjectDir\(/);
    expect(cliSrc).toMatch(/refreshMcpRegistration\(concretePlatform,\s*\{\s*projectDir\s*\}\)/);
  });

  test("refresh failure marks upgrade non-zero", () => {
    const refreshIdx = cliSrc.indexOf("refreshMcpRegistration(");
    const block = cliSrc.slice(refreshIdx, refreshIdx + 900);
    expect(block).toMatch(/process\.exitCode\s*=\s*1/);
    expect(block).toMatch(/MCP registration refresh failed/);
  });

  test("Step 4b and 4c labels appear in upgrade() so the doctor narrative is honest", () => {
    // The doctor-style step labels in upgrade() are how users read the
    // flow. These labels assert the steps participate in the upgrade
    // narrative rather than being hidden in a try.
    expect(cliSrc).toMatch(/Step\s+4b/i);
    expect(cliSrc).toMatch(/Step\s+4c/i);
  });
});
