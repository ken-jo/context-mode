import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = resolve(__dirname, "..", "..");
const runtimeModule = await import(pathToFileURL(resolve(REPO_ROOT, ".codex-plugin/global-runtime.mjs")).href);

const cleanup: string[] = [];

function makeRuntimeRoot(label: string, withHook = true) {
  const root = mkdtempSync(join(tmpdir(), `ctx-codex-runtime-${label}-`));
  cleanup.push(root);
  mkdirSync(join(root, "hooks", "codex"), { recursive: true });
  writeFileSync(join(root, "start.mjs"), "export {};\n");
  if (withHook) {
    writeFileSync(join(root, "hooks", "codex", "pretooluse.mjs"), "export {};\n");
  }
  return root;
}

afterEach(() => {
  while (cleanup.length) {
    rmSync(cleanup.pop()!, { recursive: true, force: true });
  }
});

describe(".codex-plugin/global-runtime.mjs", () => {
  it("prefers CONTEXT_MODE_GLOBAL_ROOT over the plugin cache fallback", () => {
    const globalRoot = makeRuntimeRoot("env");
    const pluginRoot = makeRuntimeRoot("plugin");

    const runtime = runtimeModule.resolveRuntimeRoot({
      pluginRoot,
      mode: "mcp",
      env: { CONTEXT_MODE_GLOBAL_ROOT: globalRoot },
      execFileSyncFn: () => "",
    });

    expect(runtime.root).toBe(resolve(globalRoot));
    expect(runtime.source).toBe("CONTEXT_MODE_GLOBAL_ROOT");
  });

  it("finds an npm-global context-mode install via npm root -g on MCP startup", () => {
    const nodeModulesRoot = mkdtempSync(join(tmpdir(), "ctx-node-modules-"));
    cleanup.push(nodeModulesRoot);
    const globalRoot = join(nodeModulesRoot, "context-mode");
    mkdirSync(globalRoot, { recursive: true });
    mkdirSync(join(globalRoot, "hooks", "codex"), { recursive: true });
    writeFileSync(join(globalRoot, "start.mjs"), "export {};\n");
    writeFileSync(join(globalRoot, "hooks", "codex", "pretooluse.mjs"), "export {};\n");
    const pluginRoot = makeRuntimeRoot("plugin");

    const runtime = runtimeModule.resolveRuntimeRoot({
      pluginRoot,
      mode: "mcp",
      env: {},
      platform: "linux",
      execFileSyncFn: (command: string, args: string[]) => {
        if (command === "pnpm") return "";
        expect(command).toBe("npm");
        expect(args).toEqual(["root", "-g"]);
        return `${nodeModulesRoot}\n`;
      },
    });

    expect(runtime.root).toBe(resolve(globalRoot));
    expect(runtime.source).toBe("npm root -g");
  });

  it("checks the Windows APPDATA npm root before spawning npm on hook hot paths", () => {
    const appDataRoot = mkdtempSync(join(tmpdir(), "ctx-appdata-"));
    cleanup.push(appDataRoot);
    const globalRoot = join(appDataRoot, "npm", "node_modules", "context-mode");
    mkdirSync(join(globalRoot, "hooks", "codex"), { recursive: true });
    writeFileSync(join(globalRoot, "start.mjs"), "export {};\n");
    writeFileSync(join(globalRoot, "hooks", "codex", "pretooluse.mjs"), "export {};\n");
    const pluginRoot = makeRuntimeRoot("plugin");

    const runtime = runtimeModule.resolveRuntimeRoot({
      pluginRoot,
      mode: "hook",
      hookEvent: "pretooluse",
      env: { APPDATA: appDataRoot },
      platform: "win32",
      execFileSyncFn: () => {
        throw new Error("npm root -g should not run when APPDATA contains context-mode");
      },
    });

    expect(runtime.root).toBe(resolve(globalRoot));
    expect(runtime.source).toBe("APPDATA npm");
  });

  it("falls back to the materialized plugin cache when no global runtime exists", () => {
    const pluginRoot = makeRuntimeRoot("plugin");

    const runtime = runtimeModule.resolveRuntimeRoot({
      pluginRoot,
      mode: "mcp",
      env: {},
      execFileSyncFn: () => "",
    });

    expect(runtime.root).toBe(resolve(pluginRoot));
    expect(runtime.source).toBe("plugin cache fallback");
  });

  it("builds hook and MCP entry paths from the selected runtime root", () => {
    const root = makeRuntimeRoot("entry");

    expect(runtimeModule.runtimeEntryFor({ root, mode: "mcp" }))
      .toBe(join(root, "start.mjs"));
    expect(runtimeModule.runtimeEntryFor({ root, mode: "hook", hookEvent: "pretooluse" }))
      .toBe(join(root, "hooks", "codex", "pretooluse.mjs"));
  });

  it("maps Codex hook event names for fail-open hook output", () => {
    expect(runtimeModule.hookEventName("pretooluse")).toBe("PreToolUse");
    expect(runtimeModule.hookEventName("posttooluse")).toBe("PostToolUse");
    expect(runtimeModule.hookEventName("sessionstart")).toBe("SessionStart");
  });
});
