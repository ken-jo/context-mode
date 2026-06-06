import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Guards the shipped agy plugin bundle (configs/antigravity-cli/), which users
 * install with `npm run install:agy` (→ `agy plugin install configs/antigravity-cli`).
 *
 * agy's plugin system is Claude-compatible: it reads `.claude-plugin/plugin.json`
 * for identity + skills, a root `.mcp.json` for MCP servers, and `hooks/hooks.json`
 * for hooks. Verified on agy 1.0.6: `agy plugin install` with a bundle `.mcp.json`
 * logs "mcpServers : 1 processed" and registers the server — env preserved — into
 * ~/.gemini/config/plugins/<name>/mcp_config.json. So MCP + skill + capture hook
 * all register in ONE command; the installer no longer writes a global MCP profile.
 *
 * Like the Copilot bundle, this `.mcp.json` IS committed (a plugin has no other
 * way to declare MCP) — .gitignore un-ignores exactly configs/antigravity-cli/.mcp.json.
 */
const PLUGIN = resolve(__dirname, "..", "..", "configs", "antigravity-cli");
const REPO_ROOT = resolve(__dirname, "..", "..");

describe("configs/antigravity-cli — agy plugin bundle", () => {
  it("ships a COMMITTED .mcp.json (git must not ignore it) pinned to antigravity-cli", () => {
    const mcpPath = resolve(PLUGIN, ".mcp.json");
    expect(existsSync(mcpPath)).toBe(true);
    // The repo-wide `.mcp.json` ignore must be negated for this path, or the
    // bundle ships with no MCP and `agy plugin install` registers none.
    let ignored = "";
    try {
      ignored = execFileSync("git", ["check-ignore", "configs/antigravity-cli/.mcp.json"], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      }).trim();
    } catch {
      // `git check-ignore` exits non-zero (no output) when NOT ignored — desired.
    }
    expect(ignored).toBe("");
    const mcp = JSON.parse(readFileSync(mcpPath, "utf-8"));
    const server = mcp.mcpServers?.["context-mode"];
    expect(server?.command).toBe("context-mode");
    // The env pin makes the server self-identify as agy, so detection / ctx_upgrade
    // resolve antigravity-cli even when ~/.claude (a gemini-cli→agy migration leaves
    // both dirs) would otherwise win — the core of #774, fixed at the MCP level.
    expect(server?.env?.CONTEXT_MODE_PLATFORM).toBe("antigravity-cli");
  });

  it("manifest declares name + the skills dir (no mcpServers — .mcp.json owns MCP)", () => {
    const manifest = JSON.parse(readFileSync(resolve(PLUGIN, ".claude-plugin", "plugin.json"), "utf-8"));
    expect(manifest.name).toBe("context-mode");
    // The routing skill is agy's ONLY enforcement (capture-only hooks, no veto).
    expect(manifest.skills).toBe("./skills/");
    // MCP lives in .mcp.json now, not duplicated in the manifest (agy plugin
    // install reads MCP from .mcp.json, not the manifest's mcpServers).
    expect(manifest.mcpServers).toBeUndefined();
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
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"));
    // A Node installer (not bash) so `npm run install:agy` runs natively on
    // Windows too — agy runs on Windows, so its installer must.
    expect(pkg.scripts["install:agy"]).toContain("scripts/install-antigravity-cli-plugin.mjs");

    const installer = resolve(REPO_ROOT, "scripts", "install-antigravity-cli-plugin.mjs");
    expect(existsSync(installer)).toBe(true);
    const body = readFileSync(installer, "utf-8");
    expect(body).toContain("agy plugin install");
    expect(body).toContain("antigravity-cli");
    // agy caches tool schemas and never refreshes them; the installer must clear
    // that cache (~/.gemini/antigravity-cli/mcp/context-mode) or the Gemini-safe
    // schema fix never reaches the model.
    expect(body).toContain("rmSync");
    expect(body).toContain('"mcp", "context-mode"');
  });
});
