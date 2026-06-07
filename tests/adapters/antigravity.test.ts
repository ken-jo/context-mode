import "../setup-home";
import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AntigravityAdapter } from "../../src/adapters/antigravity/index.js";
import {
  AntigravityCliAdapter,
  antigravityCliHooksPath,
  antigravityCliPluginDir,
} from "../../src/adapters/antigravity-cli/index.js";
import { hashProjectDirCanonical, resolveSessionDbPath } from "../../src/session/db.js";

describe("AntigravityAdapter", () => {
  let adapter: AntigravityAdapter;

  beforeEach(() => {
    adapter = new AntigravityAdapter();
  });

  // ── Identity ───────────────────────────────────────────

  describe("identity", () => {
    it("name is Antigravity", () => {
      expect(adapter.name).toBe("Antigravity");
    });

    it("paradigm is mcp-only", () => {
      expect(adapter.paradigm).toBe("mcp-only");
    });
  });

  // ── Capabilities ──────────────────────────────────────

  describe("capabilities", () => {
    it("all capabilities are false", () => {
      expect(adapter.capabilities.preToolUse).toBe(false);
      expect(adapter.capabilities.postToolUse).toBe(false);
      expect(adapter.capabilities.preCompact).toBe(false);
      expect(adapter.capabilities.sessionStart).toBe(false);
      expect(adapter.capabilities.canModifyArgs).toBe(false);
      expect(adapter.capabilities.canModifyOutput).toBe(false);
      expect(adapter.capabilities.canInjectSessionContext).toBe(false);
    });
  });

  // ── Parse methods (all throw) ─────────────────────────

  describe("parse methods", () => {
    it("parsePreToolUseInput throws", () => {
      expect(() => adapter.parsePreToolUseInput({})).toThrow(
        /Antigravity does not support hooks/,
      );
    });

    it("parsePostToolUseInput throws", () => {
      expect(() => adapter.parsePostToolUseInput({})).toThrow(
        /Antigravity does not support hooks/,
      );
    });

    it("parsePreCompactInput throws", () => {
      expect(() => adapter.parsePreCompactInput({})).toThrow(
        /Antigravity does not support hooks/,
      );
    });

    it("parseSessionStartInput throws", () => {
      expect(() => adapter.parseSessionStartInput({})).toThrow(
        /Antigravity does not support hooks/,
      );
    });
  });

  // ── Format methods (all return undefined) ─────────────

  describe("format methods", () => {
    it("formatPreToolUseResponse returns undefined", () => {
      const result = adapter.formatPreToolUseResponse({
        decision: "deny",
        reason: "test",
      });
      expect(result).toBeUndefined();
    });

    it("formatPostToolUseResponse returns undefined", () => {
      const result = adapter.formatPostToolUseResponse({
        additionalContext: "test",
      });
      expect(result).toBeUndefined();
    });

    it("formatPreCompactResponse returns undefined", () => {
      const result = adapter.formatPreCompactResponse({
        context: "test",
      });
      expect(result).toBeUndefined();
    });

    it("formatSessionStartResponse returns undefined", () => {
      const result = adapter.formatSessionStartResponse({
        context: "test",
      });
      expect(result).toBeUndefined();
    });
  });

  // ── Hook config (all empty) ───────────────────────────

  describe("hook config", () => {
    it("generateHookConfig returns empty object", () => {
      const config = adapter.generateHookConfig("/some/plugin/root");
      expect(config).toEqual({});
    });

    it("configureAllHooks returns empty array", () => {
      const changes = adapter.configureAllHooks("/some/plugin/root");
      expect(changes).toEqual([]);
    });

    it("setHookPermissions returns empty array", () => {
      const set = adapter.setHookPermissions("/some/plugin/root");
      expect(set).toEqual([]);
    });
  });

  // ── Config paths ──────────────────────────────────────

  describe("config paths", () => {
    it("settings path is ~/.gemini/antigravity/mcp_config.json", () => {
      expect(adapter.getSettingsPath()).toBe(
        resolve(homedir(), ".gemini", "antigravity", "mcp_config.json"),
      );
    });

    it("session dir is under ~/.gemini/context-mode/sessions/", () => {
      const sessionDir = adapter.getSessionDir();
      expect(sessionDir).toBe(
        join(homedir(), ".gemini", "context-mode", "sessions"),
      );
    });

    it("session DB path contains project hash", () => {
      const dbPath = resolveSessionDbPath({ projectDir: "/test/project", sessionsDir: adapter.getSessionDir() });
      expect(dbPath).toMatch(/[a-f0-9]{16}\.db$/);
      expect(dbPath).toContain(".gemini");
    });

    it("session events path contains project hash with -events.md suffix", () => {
      const eventsPath = join(adapter.getSessionDir(), `${hashProjectDirCanonical("/test/project")}-events.md`);
      expect(eventsPath).toMatch(/[a-f0-9]{16}-events\.md$/);
      expect(eventsPath).toContain(".gemini");
    });
  });

});

describe("AntigravityCliAdapter", () => {
  let adapter: AntigravityCliAdapter;

  beforeEach(() => {
    adapter = new AntigravityCliAdapter();
  });

  it("name is Antigravity CLI and paradigm is mcp-only", () => {
    expect(adapter.name).toBe("Antigravity CLI");
    expect(adapter.paradigm).toBe("mcp-only");
  });

  it("settings path is ~/.gemini/config/mcp_config.json", () => {
    expect(adapter.getSettingsPath()).toBe(
      resolve(homedir(), ".gemini", "config", "mcp_config.json"),
    );
  });

  it("config dir is ~/.gemini/antigravity-cli", () => {
    expect(adapter.getConfigDir()).toBe(
      resolve(homedir(), ".gemini", "antigravity-cli"),
    );
  });

  it("checkPluginRegistration fails with the install:agy remediation when nothing is registered", () => {
    rmSync(adapter.getSettingsPath(), { force: true });
    rmSync(join(antigravityCliPluginDir(), "mcp_config.json"), { force: true });

    expect(adapter.checkPluginRegistration()).toMatchObject({
      check: "MCP registration",
      status: "fail",
      fix: "npm run install:agy",
    });
  });

  it("checkPluginRegistration PASSES when MCP is in the plugin profile (agy plugin install)", () => {
    // B: `agy plugin install` writes MCP to ~/.gemini/config/plugins/context-mode/
    // mcp_config.json — not the global profile. doctor must recognize it.
    rmSync(adapter.getSettingsPath(), { force: true });
    const pluginMcp = join(antigravityCliPluginDir(), "mcp_config.json");
    mkdirSync(antigravityCliPluginDir(), { recursive: true });
    writeFileSync(
      pluginMcp,
      JSON.stringify({ mcpServers: { "context-mode": { command: "context-mode" } } }),
    );

    const result = adapter.checkPluginRegistration();
    expect(result.status).toBe("pass");
    expect(result.message).toContain("mcp_config.json");
    rmSync(pluginMcp, { force: true });
  });

  it("hooks path is ~/.gemini/config/hooks.json", () => {
    expect(antigravityCliHooksPath()).toBe(resolve(homedir(), ".gemini", "config", "hooks.json"));
  });

  it("configureAllHooks writes a capture-only PostToolUse hook, idempotently", () => {
    rmSync(antigravityCliHooksPath(), { force: true });

    const changes = adapter.configureAllHooks("/plugin/root");
    expect(changes.length).toBeGreaterThan(0);

    const cfg = JSON.parse(readFileSync(antigravityCliHooksPath(), "utf-8")) as {
      hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(cfg.hooks.PostToolUse[0].hooks[0].command).toBe(
      "context-mode hook antigravity-cli posttooluse",
    );

    // Second run sees no drift.
    expect(adapter.configureAllHooks("/plugin/root")).toEqual([]);
  });

  it("configureAllHooks preserves unrelated hooks already in the file", () => {
    rmSync(antigravityCliHooksPath(), { force: true });
    adapter.configureAllHooks("/plugin/root");
    // Hand-add an unrelated hook, then reconfigure — it must survive.
    const path = antigravityCliHooksPath();
    const cfg = JSON.parse(readFileSync(path, "utf-8"));
    cfg.hooks.Stop = [{ matcher: "", hooks: [{ type: "command", command: "echo bye" }] }];
    writeFileSync(path, JSON.stringify(cfg));
    adapter.configureAllHooks("/plugin/root");
    const after = JSON.parse(readFileSync(path, "utf-8"));
    expect(after.hooks.Stop).toBeDefined();
    expect(after.hooks.PostToolUse[0].hooks[0].command).toContain("antigravity-cli posttooluse");
  });

  it("validateHooks warns until the capture hook is configured, then passes (capture-only)", () => {
    rmSync(antigravityCliHooksPath(), { force: true });
    rmSync(join(antigravityCliPluginDir(), "hooks.json"), { force: true });
    const before = adapter.validateHooks("/plugin/root");
    expect(before[0].status).toBe("warn");

    adapter.configureAllHooks("/plugin/root");
    const after = adapter.validateHooks("/plugin/root");
    expect(after[0].status).toBe("pass");
    expect(after[0].message).toContain("capture-only");
  });

  it("validateHooks PASSES when the capture hook is in the plugin profile (agy plugin install)", () => {
    // B: `agy plugin install` writes the hook to ~/.gemini/config/plugins/
    // context-mode/hooks.json — not the global hooks.json. doctor must recognize it.
    rmSync(antigravityCliHooksPath(), { force: true });
    const pluginHooks = join(antigravityCliPluginDir(), "hooks.json");
    mkdirSync(antigravityCliPluginDir(), { recursive: true });
    writeFileSync(
      pluginHooks,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            { matcher: "", hooks: [{ type: "command", command: "context-mode hook antigravity-cli posttooluse" }] },
          ],
        },
      }),
    );

    expect(adapter.validateHooks("/plugin/root")[0].status).toBe("pass");
    rmSync(pluginHooks, { force: true });
  });
});

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
const AGY_PLUGIN = resolve(__dirname, "..", "..", "configs", "antigravity-cli");
const AGY_REPO_ROOT = resolve(__dirname, "..", "..");

describe("configs/antigravity-cli — agy plugin bundle", () => {
  it("ships a COMMITTED .mcp.json (git must not ignore it) pinned to antigravity-cli", () => {
    const mcpPath = resolve(AGY_PLUGIN, ".mcp.json");
    expect(existsSync(mcpPath)).toBe(true);
    // The repo-wide `.mcp.json` ignore must be negated for this path, or the
    // bundle ships with no MCP and `agy plugin install` registers none.
    let ignored = "";
    try {
      ignored = execFileSync("git", ["check-ignore", "configs/antigravity-cli/.mcp.json"], {
        cwd: AGY_REPO_ROOT,
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
    const manifest = JSON.parse(readFileSync(resolve(AGY_PLUGIN, ".claude-plugin", "plugin.json"), "utf-8"));
    expect(manifest.name).toBe("context-mode");
    // The routing skill is agy's ONLY enforcement (capture-only hooks, no veto).
    expect(manifest.skills).toBe("./skills/");
    // MCP lives in .mcp.json now, not duplicated in the manifest (agy plugin
    // install reads MCP from .mcp.json, not the manifest's mcpServers).
    expect(manifest.mcpServers).toBeUndefined();
  });

  it("hooks/hooks.json wires the capture-only PostToolUse dispatcher", () => {
    const hooks = JSON.parse(readFileSync(resolve(AGY_PLUGIN, "hooks", "hooks.json"), "utf-8"));
    const entry = hooks.hooks?.PostToolUse?.[0]?.hooks?.[0];
    expect(entry?.type).toBe("command");
    expect(entry?.command).toBe("context-mode hook antigravity-cli posttooluse");
    // capture-only: no PreToolUse (agy honors no stdout veto in auto-run mode)
    expect(hooks.hooks?.PreToolUse).toBeUndefined();
  });

  it("ships the routing skill", () => {
    expect(existsSync(resolve(AGY_PLUGIN, "skills", "context-mode", "SKILL.md"))).toBe(true);
    const skill = readFileSync(resolve(AGY_PLUGIN, "skills", "context-mode", "SKILL.md"), "utf-8");
    expect(skill).toContain("name: context-mode");
    expect(skill).toMatch(/ctx_execute|ctx_batch_execute/);
  });

  it("the dispatched hook script exists", () => {
    expect(existsSync(resolve(__dirname, "..", "..", "hooks", "antigravity-cli", "posttooluse.mjs"))).toBe(true);
  });

  it("ships the npm run install:agy one-command installer (cross-platform Node)", () => {
    const pkg = JSON.parse(readFileSync(resolve(AGY_REPO_ROOT, "package.json"), "utf-8"));
    // A Node installer (not bash) so `npm run install:agy` runs natively on
    // Windows too — agy runs on Windows, so its installer must.
    expect(pkg.scripts["install:agy"]).toContain("scripts/install-antigravity-cli-plugin.mjs");

    const installer = resolve(AGY_REPO_ROOT, "scripts", "install-antigravity-cli-plugin.mjs");
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
