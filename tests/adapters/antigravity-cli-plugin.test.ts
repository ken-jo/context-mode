import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Guards the shipped agy plugin bundle (configs/antigravity-cli/), which users
 * install with `agy plugin install configs/antigravity-cli` or
 * `agy plugin import claude`. agy routes a `.claude-plugin/`-containing dir
 * through its claude-code import path, so MCP must be declared the Claude way
 * (mcpServers in plugin.json + .mcp.json); hooks live in hooks/hooks.json.
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

  it("ships .mcp.json (Claude convention agy install reads) and mcp_config.json (agy-native)", () => {
    for (const f of [".mcp.json", "mcp_config.json"]) {
      const mcp = JSON.parse(readFileSync(resolve(PLUGIN, f), "utf-8"));
      expect(mcp.mcpServers?.["context-mode"]?.command).toBe("context-mode");
    }
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

  it("ships the npm run install:agy one-command installer (parity with install:openclaw)", () => {
    const repoRoot = resolve(__dirname, "..", "..");
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8"));
    // Mirrors the install:openclaw script shape so the install UX is consistent.
    expect(pkg.scripts["install:agy"]).toContain("scripts/install-antigravity-cli-plugin.sh");

    const sh = resolve(repoRoot, "scripts", "install-antigravity-cli-plugin.sh");
    expect(existsSync(sh)).toBe(true);
    const body = readFileSync(sh, "utf-8");
    expect(body).toContain("agy plugin install");
    expect(body).toContain("configs/antigravity-cli");
  });
});
