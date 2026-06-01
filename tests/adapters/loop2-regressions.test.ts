/**
 * Loop-2 regression guards — the whole-branch verification loop found these
 * setup↔doctor / platform-load breaks; lock them so they can't return.
 *
 *  - openclaw: `context-mode upgrade` (adapter.configureAllHooks) MUST register
 *    the MCP sidecar (mcp.servers.context-mode) — without it OpenClaw loads the
 *    plugin but no ctx_* tools reach the agent; checkPluginRegistration MUST
 *    require BOTH plugins.entries AND mcp.servers.
 *  - pi: the GLOBAL extension read path MUST include the `agent/` segment
 *    (~/.pi/agent/extensions/), the path Pi actually auto-discovers from.
 *  - zed: settings.json is JSONC — doctor MUST parse a commented file, not
 *    false-fail it.
 */

import { afterEach, describe, it, expect } from "vitest";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";

const tmps: string[] = [];
function mkTmp(p = "ctx-loop2-"): string {
  const d = mkdtempSync(join(tmpdir(), p));
  tmps.push(d);
  return d;
}
const origHome = process.env.HOME;
const origUserProfile = process.env.USERPROFILE;
const origCwd = process.cwd();
afterEach(() => {
  try { process.chdir(origCwd); } catch { /* ignore */ }
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUserProfile;
  while (tmps.length) {
    const d = tmps.pop();
    if (d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
});
function withHome(h: string) { process.env.HOME = h; process.env.USERPROFILE = h; }

describe("openclaw: upgrade registers the MCP sidecar (Loop-2)", () => {
  it("configureAllHooks writes mcp.servers.context-mode + checkPluginRegistration requires it", async () => {
    const { OpenClawAdapter } = await import("../../src/adapters/openclaw/index.js");
    const dir = mkTmp("ctx-loop2-openclaw-");
    process.chdir(dir); // writeSettings + readSettings resolve openclaw.json in cwd
    const adapter = new OpenClawAdapter();

    // Before configureAllHooks: a plugins.entries-only config must NOT pass.
    writeFileSync(
      resolve(dir, "openclaw.json"),
      JSON.stringify({ plugins: { entries: { "context-mode": { enabled: true } } } }),
    );
    expect(adapter.checkPluginRegistration().status).toBe("fail");

    // configureAllHooks must add the MCP sidecar.
    adapter.configureAllHooks("/abs/plugin/root");
    const cfg = JSON.parse(readFileSync(resolve(dir, "openclaw.json"), "utf-8"));
    expect(cfg.mcp?.servers?.["context-mode"]).toBeDefined();
    expect(cfg.mcp.servers["context-mode"].command).toBe("node");
    expect(cfg.mcp.servers["context-mode"].args[0]).toMatch(/server\.bundle\.mjs$/);
    // plugins.allow mirrors the installer.
    expect(cfg.plugins.allow).toContain("context-mode");

    // Now doctor passes (both entries + mcp.servers present).
    expect(adapter.checkPluginRegistration().status).toBe("pass");
  });
});

describe("pi: global extension read path includes the agent/ segment (Loop-2 / DI-7)", () => {
  it("checkPluginRegistration PASSES at ~/.pi/agent/extensions/ and FAILS at the old ~/.pi/extensions/", async () => {
    const { PiAdapter } = await import("../../src/adapters/pi/index.js");

    // Correct global path (with agent/) → pass.
    const home1 = mkTmp("ctx-loop2-pi-ok-");
    withHome(home1);
    const ok = resolve(home1, ".pi", "agent", "extensions", "context-mode");
    mkdirSync(ok, { recursive: true });
    writeFileSync(join(ok, "package.json"), JSON.stringify({ name: "context-mode", version: "1.2.3" }));
    writeFileSync(join(ok, "index.js"), `export { default } from "file:///tmp/context-mode/build/adapters/pi/extension.js";`);
    expect(new PiAdapter().checkPluginRegistration().status).toBe("pass");
    expect(new PiAdapter().getInstalledVersion()).toBe("1.2.3");

    // Old path (no agent/) → NOT discovered → fail.
    const home2 = mkTmp("ctx-loop2-pi-old-");
    withHome(home2);
    const old = resolve(home2, ".pi", "extensions", "context-mode");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "package.json"), JSON.stringify({ name: "context-mode", version: "1.2.3" }));
    expect(new PiAdapter().checkPluginRegistration().status).toBe("fail");
  });
});

describe("zed: doctor parses JSONC settings.json (Loop-2)", () => {
  it("checkPluginRegistration PASSES on a valid commented settings.json", async () => {
    const { ZedAdapter } = await import("../../src/adapters/zed/index.js");
    const home = mkTmp("ctx-loop2-zed-");
    withHome(home);
    // zedSettingsPath() is platform-aware; reuse it so the test writes where
    // the adapter reads on this OS (Loop-3/4).
    const { zedSettingsPath } = await import("../../src/adapters/zed/index.js");
    const p = zedSettingsPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(
      p,
      '{\n  // Zed config is JSONC\n  "context_servers": {\n    "context-mode": { "command": "context-mode", "args": [] },\n  }\n}\n',
    );
    expect(new ZedAdapter().checkPluginRegistration().status).toBe("pass");
  });
});

describe("doctor parses JSONC config for all home-rooted adapters (Loop-4)", () => {
  // setup writes JSONC-tolerant; doctor must read the SAME commented files
  // without false-failing. One commented config per adapter → PASS.
  const cases: Array<{
    id: string;
    rel: string[];
    container: string;
    load: () => Promise<{ checkPluginRegistration(): { status: string } }>;
  }> = [
    { id: "gemini-cli", rel: [".gemini", "settings.json"], container: "mcpServers",
      load: async () => new (await import("../../src/adapters/gemini-cli/index.js")).GeminiCLIAdapter() },
    { id: "qwen-code", rel: [".qwen", "settings.json"], container: "mcpServers",
      load: async () => new (await import("../../src/adapters/qwen-code/index.js")).QwenCodeAdapter() },
    { id: "kiro", rel: [".kiro", "settings", "mcp.json"], container: "mcpServers",
      load: async () => new (await import("../../src/adapters/kiro/index.js")).KiroAdapter() },
    { id: "antigravity", rel: [".gemini", "antigravity", "mcp_config.json"], container: "mcpServers",
      load: async () => new (await import("../../src/adapters/antigravity/index.js")).AntigravityAdapter() },
    { id: "vscode-copilot", rel: [".vscode", "mcp.json"], container: "servers",
      load: async () => new (await import("../../src/adapters/vscode-copilot/index.js")).VSCodeCopilotAdapter() },
    { id: "cursor", rel: [".cursor", "mcp.json"], container: "mcpServers",
      load: async () => new (await import("../../src/adapters/cursor/index.js")).CursorAdapter() },
  ];

  for (const c of cases) {
    it(`${c.id}: checkPluginRegistration PASSES on a commented config`, async () => {
      const home = mkTmp(`ctx-loop4-${c.id}-`);
      withHome(home);
      const p = resolve(home, ...c.rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(
        p,
        `{\n  // ${c.id} config can be JSONC\n  "${c.container}": {\n    "context-mode": { "command": "context-mode" },\n  }\n}\n`,
      );
      const adapter = await c.load();
      expect(adapter.checkPluginRegistration().status).toBe("pass");
    });
  }
});
