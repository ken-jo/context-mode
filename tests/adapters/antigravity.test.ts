import "../setup-home";
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AntigravityAdapter } from "../../src/adapters/antigravity/index.js";
import { AntigravityCliAdapter, antigravityCliHooksPath } from "../../src/adapters/antigravity-cli/index.js";
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

  it("checkPluginRegistration fails with mcpServers remediation when config is missing", () => {
    rmSync(adapter.getSettingsPath(), { force: true });

    expect(adapter.checkPluginRegistration()).toMatchObject({
      check: "MCP registration",
      status: "fail",
      fix: `Add context-mode to mcpServers in ${resolve(homedir(), ".gemini", "config", "mcp_config.json")}`,
    });
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
    const before = adapter.validateHooks("/plugin/root");
    expect(before[0].status).toBe("warn");

    adapter.configureAllHooks("/plugin/root");
    const after = adapter.validateHooks("/plugin/root");
    expect(after[0].status).toBe("pass");
    expect(after[0].message).toContain("capture-only");
  });
});
