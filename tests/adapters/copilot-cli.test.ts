import "../setup-home";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { readFileSync, rmSync } from "node:fs";
import { CopilotCliAdapter, copilotCliMcpConfigPath } from "../../src/adapters/copilot-cli/index.js";
import { HOOK_TYPES, HOOK_SCRIPTS, buildHookCommand } from "../../src/adapters/copilot-cli/hooks.js";

describe("CopilotCliAdapter", () => {
  let adapter: CopilotCliAdapter;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    delete process.env.COPILOT_HOME;
    adapter = new CopilotCliAdapter();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  describe("capabilities", () => {
    it("uses json-stdio hooks", () => {
      expect(adapter.paradigm).toBe("json-stdio");
      expect(adapter.capabilities.preToolUse).toBe(true);
      expect(adapter.capabilities.postToolUse).toBe(true);
      expect(adapter.capabilities.preCompact).toBe(true);
      expect(adapter.capabilities.sessionStart).toBe(true);
    });
  });

  describe("paths", () => {
    it("uses ~/.copilot/mcp-config.json for MCP registration", () => {
      expect(copilotCliMcpConfigPath()).toBe(resolve(homedir(), ".copilot", "mcp-config.json"));
    });

    it("uses ~/.copilot/hooks/context-mode.json for hook registration", () => {
      expect(adapter.getSettingsPath()).toBe(
        resolve(homedir(), ".copilot", "hooks", "context-mode.json"),
      );
    });

    it("honors COPILOT_HOME", () => {
      process.env.COPILOT_HOME = resolve(homedir(), "custom-copilot");
      expect(copilotCliMcpConfigPath()).toBe(
        resolve(homedir(), "custom-copilot", "mcp-config.json"),
      );
      expect(adapter.getSettingsPath()).toBe(
        resolve(homedir(), "custom-copilot", "hooks", "context-mode.json"),
      );
    });

    it("session dir is under ~/.copilot/context-mode/sessions", () => {
      const sessionDir = adapter.getSessionDir();
      expect(sessionDir).toBe(join(homedir(), ".copilot", "context-mode", "sessions"));
    });
  });

  describe("hook config", () => {
    it("buildHookCommand emits CLI dispatcher form", () => {
      expect(buildHookCommand(HOOK_TYPES.PRE_TOOL_USE)).toBe("context-mode hook copilot-cli pretooluse");
    });

    it("generateHookConfig writes flat entries for every hook", () => {
      const config = adapter.generateHookConfig("/any/plugin/root") as Record<string, Array<{ command?: string; hooks?: unknown }>>;
      expect(Object.keys(config).sort()).toEqual(Object.values(HOOK_TYPES).sort());
      for (const [hookType, entries] of Object.entries(config)) {
        expect(HOOK_SCRIPTS[hookType]).toBeDefined();
        expect(entries[0].command).toBe(`context-mode hook copilot-cli ${hookType.toLowerCase()}`);
        expect(entries[0].hooks).toBeUndefined();
      }
    });

    it("configureAllHooks writes version:1 + flat hooks, then is idempotent", () => {
      const settingsPath = adapter.getSettingsPath();
      rmSync(settingsPath, { force: true });

      const changes = adapter.configureAllHooks("/any/plugin/root");
      expect(changes.length).toBeGreaterThan(0);

      const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
        version?: number;
        hooks?: Record<string, Array<{ type?: string; command?: string; hooks?: unknown }>>;
      };
      // GitHub Copilot CLI rejects the file without a top-level version:1.
      expect(written.version).toBe(1);
      expect(written.hooks?.[HOOK_TYPES.PRE_TOOL_USE]?.[0]).toEqual({
        type: "command",
        command: "context-mode hook copilot-cli pretooluse",
      });
      // Flat shape — no nested Claude-Code matcher/hooks wrapper.
      expect(written.hooks?.[HOOK_TYPES.PRE_TOOL_USE]?.[0].hooks).toBeUndefined();

      // A second run sees no drift and writes nothing.
      expect(adapter.configureAllHooks("/any/plugin/root")).toEqual([]);
    });
  });

  describe("parse and format", () => {
    it("parses snake_case Copilot CLI payload", () => {
      const event = adapter.parsePreToolUseInput({
        session_id: "copilot-session",
        cwd: "/repo",
        tool_name: "Bash",
        tool_input: { command: "pwd" },
      });

      expect(event.sessionId).toBe("copilot-session");
      expect(event.projectDir).toBe("/repo");
      expect(event.toolName).toBe("Bash");
      expect(event.toolInput).toEqual({ command: "pwd" });
    });

    it("formats PreToolUse decisions with Copilot CLI top-level fields", () => {
      expect(adapter.formatPreToolUseResponse({
        decision: "deny",
        reason: "no",
      })).toEqual({
        permissionDecision: "deny",
        permissionDecisionReason: "no",
      });

      expect(adapter.formatPreToolUseResponse({
        decision: "modify",
        updatedInput: { command: "echo ok" },
      })).toEqual({
        modifiedArgs: { command: "echo ok" },
      });

      expect(adapter.formatPreToolUseResponse({
        decision: "context",
        additionalContext: "ctx",
      })).toEqual({
        additionalContext: "ctx",
      });
    });

    it("formats SessionStart context as top-level additionalContext", () => {
      expect(adapter.formatSessionStartResponse({ context: "hello" })).toEqual({
        additionalContext: "hello",
      });
    });
  });

  describe("plugin registration", () => {
    it("fails with manual-MCP remediation when mcp-config.json is missing", () => {
      rmSync(copilotCliMcpConfigPath(), { force: true });

      // `context-mode upgrade` writes hooks only; Copilot CLI's own
      // `copilot mcp add` is the clean way to register the MCP server.
      expect(adapter.checkPluginRegistration()).toMatchObject({
        check: "MCP registration",
        status: "fail",
        fix: "copilot mcp add context-mode -- context-mode",
      });
    });
  });
});
