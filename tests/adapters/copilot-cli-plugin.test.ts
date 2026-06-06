import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Guards the shipped GitHub Copilot CLI plugin bundle (configs/copilot-cli/),
 * which users install with `copilot plugin install mksglu/context-mode:configs/copilot-cli`.
 *
 * Copilot auto-discovers a plugin's components from fixed filenames (verified
 * against real marketplace plugins, github/copilot-plugins + github/awesome-copilot):
 *   MCP    → `.mcp.json` in the plugin root
 *   skills → `skills/<name>/SKILL.md`
 *   manifest (optional metadata) → `.github/plugin/plugin.json`
 *
 * Unlike every other bundle in this repo, this `.mcp.json` IS committed: a
 * Copilot plugin has no other way to declare MCP, so .gitignore un-ignores
 * exactly `configs/copilot-cli/.mcp.json` (the repo-wide `.mcp.json` ignore from
 * #253/#531 guards the repo-ROOT dev file, not a plugin's own config).
 */
const PLUGIN = resolve(__dirname, "..", "..", "configs", "copilot-cli");
const REPO_ROOT = resolve(__dirname, "..", "..");

describe("configs/copilot-cli — GitHub Copilot CLI plugin bundle", () => {
  it("ships a COMMITTED .mcp.json (git must not ignore it)", () => {
    const mcpPath = resolve(PLUGIN, ".mcp.json");
    expect(existsSync(mcpPath)).toBe(true);
    // The repo-wide `.mcp.json` ignore must be negated for this one path, or the
    // plugin ships with no MCP config and `copilot plugin install` is a no-op.
    let ignored = "";
    try {
      ignored = execFileSync("git", ["check-ignore", "configs/copilot-cli/.mcp.json"], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      }).trim();
    } catch {
      // `git check-ignore` exits non-zero (no output) when the path is NOT
      // ignored — exactly what we want.
    }
    expect(ignored).toBe("");
  });

  it(".mcp.json declares the context-mode server pinned to CONTEXT_MODE_PLATFORM=copilot-cli", () => {
    const mcp = JSON.parse(readFileSync(resolve(PLUGIN, ".mcp.json"), "utf-8"));
    const server = mcp.mcpServers?.["context-mode"];
    expect(server?.command).toBe("context-mode");
    // The env pin is the whole point: it makes the server self-identify as
    // Copilot, so ctx_upgrade / platform detection resolve copilot-cli even when
    // Claude Code is co-installed (otherwise ~/.claude wins and writes Claude's
    // config instead of Copilot's).
    expect(server?.env?.CONTEXT_MODE_PLATFORM).toBe("copilot-cli");
  });

  it("ships the routing skill at skills/context-mode/SKILL.md", () => {
    const skillPath = resolve(PLUGIN, "skills", "context-mode", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    const skill = readFileSync(skillPath, "utf-8");
    expect(skill).toContain("name: context-mode");
    expect(skill).toMatch(/ctx_execute|ctx_batch_execute/);
  });

  it("manifest declares name + the skill dir", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(PLUGIN, ".github", "plugin", "plugin.json"), "utf-8"),
    );
    expect(manifest.name).toBe("context-mode");
    expect(manifest.skills).toContain("./skills/context-mode");
  });
});
