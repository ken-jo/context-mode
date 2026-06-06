#!/usr/bin/env node
/**
 * Cross-platform installer: register the context-mode plugin into Antigravity CLI (agy).
 *
 * Replaces the former bash-only scripts/install-antigravity-cli-plugin.sh so
 * `npm run install:agy` runs natively on Windows (PowerShell/cmd) as well as
 * macOS/Linux. agy itself runs on Windows, so its installer must too — unlike
 * the openclaw installer, which is genuinely POSIX-only (signals, pgrep, /tmp).
 *
 * The bundle (configs/antigravity-cli/) registers the context-mode MCP server,
 * the routing skill, and a PostToolUse capture hook in one step.
 *
 * Usage: npm run install:agy   (or: node scripts/install-antigravity-cli-plugin.mjs)
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const isWin = process.platform === "win32";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = resolve(repoRoot, "configs", "antigravity-cli");

// Double-quote a path so a clone dir with spaces survives the shell on both
// cmd.exe and /bin/sh (paths never contain literal quotes).
const q = (s) => `"${s}"`;

// Cross-platform "is <cmd> on PATH?" — `where` on Windows, `command -v` on POSIX.
// shell:true is required: `command -v` is a shell builtin and `where`/`agy` may
// resolve to a .cmd shim on Windows that only the shell can launch.
function onPath(cmd) {
  const probe = isWin ? `where ${cmd}` : `command -v ${cmd}`;
  return spawnSync(probe, { stdio: "ignore", shell: true }).status === 0;
}

// — preflight —
if (!onPath("agy")) {
  console.error("✗ 'agy' (Antigravity CLI) not found in PATH. Install agy first, then re-run.");
  process.exit(1);
}
if (!existsSync(bundle)) {
  console.error(`✗ plugin bundle not found at ${bundle}`);
  process.exit(1);
}

console.log("→ context-mode agy plugin installer");
console.log(`  bundle : ${bundle}`);

// The plugin's MCP server runs the global `context-mode` binary (it needs the
// native better-sqlite3 dependency, which a bare clone does not have). Warn — do
// not silently global-install on the user's behalf.
const hasContextMode = onPath("context-mode");
if (!hasContextMode) {
  console.error("⚠ 'context-mode' is not on PATH — the plugin's MCP server requires it.");
  console.error("  Install it with:  npm install -g context-mode");
}

// Run `agy plugin install <bundle>`. String command + shell:true so cmd.exe can
// resolve agy's .cmd shim on Windows; the quoted bundle path handles spaces.
const install = spawnSync(`agy plugin install ${q(bundle)}`, { stdio: "inherit", shell: true });
if (install.status !== 0) {
  console.error(`✗ 'agy plugin install' failed (exit ${install.status ?? "unknown"}).`);
  process.exit(install.status ?? 1);
}

// Probe whether the global `context-mode` understands the antigravity-cli hook.
// The shipped hook command (`context-mode hook antigravity-cli posttooluse`)
// resolves the GLOBAL binary at runtime. A context-mode older than the release
// that added Antigravity CLI support has no `antigravity-cli` HOOK_MAP entry and
// exits non-zero — and the dispatcher suppresses stderr, so the capture hook
// would be a SILENT no-op. Detect that here and tell the user instead.
let captureOk = false;
if (hasContextMode) {
  const probe = spawnSync("context-mode hook antigravity-cli posttooluse", {
    input: "{}",
    stdio: ["pipe", "ignore", "ignore"],
    shell: true,
  });
  captureOk = probe.status === 0;
}

console.log("");
console.log("✓ Installed the context-mode agy plugin: MCP server + routing skill.");
if (captureOk) {
  console.log("✓ PostToolUse capture hook is ACTIVE (this context-mode supports antigravity-cli).");
} else {
  console.error("⚠ PostToolUse capture hook is INACTIVE: your global 'context-mode' is missing or too old");
  console.error("  to handle 'context-mode hook antigravity-cli'. MCP tools + the routing skill still work.");
  console.error("  Enable capture with:  npm install -g context-mode@latest");
}
console.log("");
console.log("  Restart agy, then verify:");
console.log('    agy -p "Use the context-mode ctx_execute MCP tool to compute 7 + 5. Answer only the number." --dangerously-skip-permissions');
console.log("  Expected output: 12");
