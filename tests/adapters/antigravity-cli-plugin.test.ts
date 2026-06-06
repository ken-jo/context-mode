import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Guards the shipped agy plugin bundle (configs/antigravity-cli/), which users
 * install with `agy plugin install configs/antigravity-cli` or
 * `agy plugin import claude`. agy routes a `.claude-plugin/`-containing dir
 * through its claude-code import path, so MCP must be declared the Claude way
 * (mcpServers in .claude-plugin/plugin.json, mirrored by the agy-native
 * mcp_config.json); hooks live in hooks/hooks.json.
 *
 * NOTE: .mcp.json is intentionally NOT shipped in the bundle. It is gitignored
 * repo-wide (see .gitignore) — committing it has silently broken fresh installs
 * before (#253/#531), so end users get MCP from plugin.json's mcpServers on
 * `agy plugin install`, never from a bundle .mcp.json.
 */
const PLUGIN = resolve(__dirname, "..", "..", "configs", "antigravity-cli");

describe("configs/antigravity-cli — agy plugin bundle", () => {
  it("manifest declares the MCP server AND the skills dir (skills key must not silently drop)", () => {
    const manifest = JSON.parse(readFileSync(resolve(PLUGIN, ".claude-plugin", "plugin.json"), "utf-8"));
    expect(manifest.name).toBe("context-mode");
    expect(manifest.mcpServers?.["context-mode"]?.command).toBe("context-mode");
    // The routing skill is agy's ONLY enforcement (capture-only hooks, no veto),
    // so the manifest must declare it like every other Claude-layout manifest.
    expect(manifest.skills).toBe("./skills/");
  });

  it("ships mcp_config.json (agy-native) declaring the context-mode MCP server", () => {
    // The Claude-way MCP declaration (.claude-plugin/plugin.json mcpServers) is
    // asserted above. .mcp.json is intentionally NOT shipped — it is gitignored
    // repo-wide and committing it has regressed fresh installs (#253/#531).
    const mcp = JSON.parse(readFileSync(resolve(PLUGIN, "mcp_config.json"), "utf-8"));
    expect(mcp.mcpServers?.["context-mode"]?.command).toBe("context-mode");
  });

  it("hooks/hooks.json wires the capture-only PostToolUse dispatcher", () => {
    const hooks = JSON.parse(readFileSync(resolve(PLUGIN, "hooks", "hooks.json"), "utf-8"));
    const entry = hooks.hooks?.PostToolUse?.[0]?.hooks?.[0];
    expect(entry?.type).toBe("command");
    expect(entry?.command).toBe("context-mode hook antigravity-cli posttooluse");
    // capture-only: no PreToolUse (agy honors no stdout veto in auto-run mode)
    expect(hooks.hooks?.PreToolUse).toBeUndefined();
  });

  it("ships the routing skill", () => {
    expect(existsSync(resolve(PLUGIN, "skills", "context-mode", "SKILL.md"))).toBe(true);
    const skill = readFileSync(resolve(PLUGIN, "skills", "context-mode", "SKILL.md"), "utf-8");
    expect(skill).toContain("name: context-mode");
    expect(skill).toMatch(/ctx_execute|ctx_batch_execute/);
  });

  it("the dispatched hook script exists", () => {
    expect(existsSync(resolve(__dirname, "..", "..", "hooks", "antigravity-cli", "posttooluse.mjs"))).toBe(true);
  });

  it("ships the npm run install:agy one-command installer (cross-platform Node)", () => {
    const repoRoot = resolve(__dirname, "..", "..");
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8"));
    // A Node installer (not bash) so `npm run install:agy` runs natively on
    // Windows too — agy runs on Windows, so its installer must (unlike the
    // POSIX-only openclaw installer).
    expect(pkg.scripts["install:agy"]).toContain("scripts/install-antigravity-cli-plugin.mjs");

    const installer = resolve(repoRoot, "scripts", "install-antigravity-cli-plugin.mjs");
    expect(existsSync(installer)).toBe(true);
    const body = readFileSync(installer, "utf-8");
    expect(body).toContain("agy plugin install");
    expect(body).toContain("antigravity-cli");
    // agy plugin install skips mcpServers, so the installer must also register
    // the MCP server in agy's global profile (~/.gemini/config/mcp_config.json).
    expect(body).toContain("mcp_config.json");
    // agy caches tool schemas and never refreshes them; the installer must clear
    // that cache (~/.gemini/antigravity-cli/mcp/context-mode) or the Gemini-safe
    // schema fix never reaches the model.
    expect(body).toContain("rmSync");
    expect(body).toContain('"mcp", "context-mode"');
  });
});
