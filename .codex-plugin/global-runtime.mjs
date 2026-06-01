#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF_PATH = fileURLToPath(import.meta.url);
const SELF_PLUGIN_ROOT = resolve(dirname(SELF_PATH), "..");
const PACKAGE_NAME = "context-mode";
const GLOBAL_ROOT_ENVS = ["CONTEXT_MODE_GLOBAL_ROOT", "CONTEXT_MODE_RUNTIME_ROOT"];
const HOOK_FILES = {
  pretooluse: "pretooluse.mjs",
  posttooluse: "posttooluse.mjs",
  precompact: "precompact.mjs",
  sessionstart: "sessionstart.mjs",
  userpromptsubmit: "userpromptsubmit.mjs",
  stop: "stop.mjs",
};

function trimPath(value) {
  return typeof value === "string" ? value.trim().replace(/^["']|["']$/g, "") : "";
}

function realpathOrResolve(path, realpathSyncFn = realpathSync) {
  try {
    return realpathSyncFn(path);
  } catch {
    return resolve(path);
  }
}

function isAbsoluteRuntimePath(path, platform) {
  if (!path) return false;
  if (platform === "win32") return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
  return path.startsWith("/");
}

function candidateKey(root, platform) {
  return platform === "win32" ? root.toLowerCase() : root;
}

function pushUnique(candidates, seen, rawPath, source, platform) {
  const path = trimPath(rawPath);
  if (!path) return;
  if (!isAbsoluteRuntimePath(path, platform)) return;
  const root = resolve(path);
  const key = candidateKey(root, platform);
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push({ root, source });
}

function commandOutput(command, args, { platform, execFileSyncFn }) {
  const binary = platform === "win32" && !/\.(cmd|exe)$/i.test(command)
    ? `${command}.cmd`
    : command;
  try {
    return String(execFileSyncFn(binary, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    })).trim();
  } catch {
    return "";
  }
}

function collectNpmRootCandidates(options) {
  const roots = [];
  const npmRoot = commandOutput("npm", ["root", "-g"], options);
  if (npmRoot) roots.push(npmRoot);

  const pnpmRoot = commandOutput("pnpm", ["root", "-g"], options);
  if (pnpmRoot) roots.push(pnpmRoot);

  return roots;
}

export function collectRuntimeRootCandidates({
  pluginRoot = SELF_PLUGIN_ROOT,
  env = process.env,
  platform = process.platform,
  execFileSyncFn = execFileSync,
  includeNpmRootProbe = true,
} = {}) {
  const candidates = [];
  const seen = new Set();

  for (const envName of GLOBAL_ROOT_ENVS) {
    pushUnique(candidates, seen, env[envName], envName, platform);
  }

  const npmPrefix = trimPath(env.npm_config_prefix);
  if (npmPrefix) {
    pushUnique(candidates, seen, join(npmPrefix, "node_modules", PACKAGE_NAME), "npm_config_prefix", platform);
  }

  if (platform === "win32") {
    if (trimPath(env.APPDATA)) {
      pushUnique(candidates, seen, join(env.APPDATA, "npm", "node_modules", PACKAGE_NAME), "APPDATA npm", platform);
    }
  } else {
    pushUnique(candidates, seen, join(homedir(), ".npm-global", "lib", "node_modules", PACKAGE_NAME), "home npm-global", platform);
    pushUnique(candidates, seen, join("/usr/local/lib/node_modules", PACKAGE_NAME), "usr-local npm", platform);
  }

  if (includeNpmRootProbe) {
    for (const nodeModulesRoot of collectNpmRootCandidates({ platform, execFileSyncFn })) {
      pushUnique(candidates, seen, join(nodeModulesRoot, PACKAGE_NAME), "npm root -g", platform);
    }
  }

  pushUnique(candidates, seen, pluginRoot, "plugin cache fallback", platform);
  return candidates;
}

export function hasMcpRuntime(root, existsSyncFn = existsSync) {
  return existsSyncFn(join(root, "start.mjs"));
}

export function hasHookRuntime(root, hookEvent, existsSyncFn = existsSync) {
  const hookFile = HOOK_FILES[hookEvent];
  return Boolean(hookFile && existsSyncFn(join(root, "hooks", "codex", hookFile)));
}

export function resolveRuntimeRoot({
  pluginRoot = SELF_PLUGIN_ROOT,
  mode = "mcp",
  hookEvent,
  env = process.env,
  platform = process.platform,
  execFileSyncFn = execFileSync,
  existsSyncFn = existsSync,
  realpathSyncFn = realpathSync,
} = {}) {
  const candidates = collectRuntimeRootCandidates({
    pluginRoot,
    env,
    platform,
    execFileSyncFn,
    includeNpmRootProbe: mode !== "hook",
  });

  for (const candidate of candidates) {
    const usable = mode === "hook"
      ? hasHookRuntime(candidate.root, hookEvent, existsSyncFn)
      : hasMcpRuntime(candidate.root, existsSyncFn);
    if (!usable) continue;
    return {
      root: realpathOrResolve(candidate.root, realpathSyncFn),
      source: candidate.source,
    };
  }

  const wanted = mode === "hook" ? `hooks/codex/${HOOK_FILES[hookEvent] || `${hookEvent}.mjs`}` : "start.mjs";
  throw new Error(`Unable to find a usable context-mode runtime containing ${wanted}`);
}

export function hookEventName(hookEvent) {
  switch (hookEvent) {
    case "pretooluse": return "PreToolUse";
    case "posttooluse": return "PostToolUse";
    case "precompact": return "PreCompact";
    case "sessionstart": return "SessionStart";
    case "userpromptsubmit": return "UserPromptSubmit";
    case "stop": return "Stop";
    default: return "";
  }
}

export function runtimeEntryFor({ root, mode, hookEvent }) {
  if (mode === "mcp") return join(root, "start.mjs");
  const hookFile = HOOK_FILES[hookEvent];
  if (!hookFile) throw new Error(`Unknown Codex hook event '${hookEvent}'`);
  return join(root, "hooks", "codex", hookFile);
}

async function main(argv = process.argv.slice(2)) {
  const [mode = "mcp", hookEventRaw] = argv;
  const hookEvent = hookEventRaw?.toLowerCase();
  if (mode !== "mcp" && mode !== "hook") {
    throw new Error(`Usage: global-runtime.mjs mcp | hook <${Object.keys(HOOK_FILES).join("|")}>`);
  }
  if (mode === "hook" && !HOOK_FILES[hookEvent]) {
    throw new Error(`Unknown Codex hook event '${hookEventRaw || ""}'`);
  }

  process.env.CONTEXT_MODE_PLATFORM = "codex";
  process.env.CONTEXT_MODE_CODEX_PLUGIN_ROOT ||= SELF_PLUGIN_ROOT;

  let runtime;
  try {
    runtime = resolveRuntimeRoot({
      pluginRoot: SELF_PLUGIN_ROOT,
      mode,
      hookEvent,
    });
  } catch (error) {
    if (mode === "hook") {
      process.stderr.write(`[context-mode codex runtime] ${error instanceof Error ? error.message : String(error)}\n`);
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: hookEventName(hookEvent) } }) + "\n");
      return;
    }
    throw error;
  }
  process.env.CONTEXT_MODE_EFFECTIVE_ROOT = runtime.root;

  const entry = runtimeEntryFor({ root: runtime.root, mode, hookEvent });
  await import(pathToFileURL(entry).href);
}

if (process.argv[1] && realpathOrResolve(process.argv[1]) === realpathOrResolve(SELF_PATH)) {
  main().catch((error) => {
    process.stderr.write(`[context-mode codex runtime] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
