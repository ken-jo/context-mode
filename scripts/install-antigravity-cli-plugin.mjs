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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

// `agy plugin install` registers the skill + capture hook but SKIPS mcpServers
// (verified against agy 1.0.5: it logs "mcpServers : skipped (not found)" because
// it reads MCP only from a bundle `.mcp.json`, which we do not ship — gitignored
// repo-wide after #253/#531). agy has no `agy mcp add` command; it loads its
// GLOBAL MCP profile from ~/.gemini/config/mcp_config.json (verified: writing
// there makes the ctx_* tools resolve), so register context-mode there directly.
const mcpPath = join(homedir(), ".gemini", "config", "mcp_config.json");
let mcpOk = false;
try {
  let cfg = {};
  if (existsSync(mcpPath)) {
    try {
      const parsed = JSON.parse(readFileSync(mcpPath, "utf8"));
      if (parsed && typeof parsed === "object") cfg = parsed;
    } catch {
      // malformed JSON — start fresh rather than crash the install
    }
  }
  if (!cfg.mcpServers || typeof cfg.mcpServers !== "object") cfg.mcpServers = {};
  const cur = cfg.mcpServers["context-mode"];
  if (!cur || cur.command !== "context-mode") {
    cfg.mcpServers["context-mode"] = { command: "context-mode" };
    mkdirSync(dirname(mcpPath), { recursive: true });
    writeFileSync(mcpPath, JSON.stringify(cfg, null, 2) + "\n");
  }
  mcpOk = cfg.mcpServers["context-mode"]?.command === "context-mode";
} catch (err) {
  console.error(`⚠ Could not register the MCP server in ${mcpPath}: ${err.message}`);
  console.error('  Add it manually: { "mcpServers": { "context-mode": { "command": "context-mode" } } }');
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
console.log(`✓ Installed the context-mode agy plugin: routing skill${mcpOk ? " + MCP server" : ""}.`);
if (mcpOk) {
  console.log(`✓ MCP server registered in ${mcpPath} (agy's global MCP profile).`);
} else {
  console.error(`⚠ MCP server NOT registered — add context-mode to ${mcpPath} manually.`);
}
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
