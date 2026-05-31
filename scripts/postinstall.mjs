#!/usr/bin/env node
/**
 * postinstall — cross-platform post-install tasks
 *
 * 1. OpenClaw detection (print helper message)
 * 2. Windows global install: fix broken bin→node_modules path
 *    when nvm4w places the shim and node_modules in different directories.
 *    Creates a directory junction so npm's %~dp0\node_modules\... resolves.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, lstatSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { healBetterSqlite3Binding } from "./heal-better-sqlite3.mjs";
import { runRuntimeHealSuite } from "./lib/heal/runtime-heal-suite.mjs";
import { runRuntimePrecheck } from "./lib/runtime-precheck.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");

// Resolve the Claude Code config dir, honoring $CLAUDE_CONFIG_DIR (incl.
// leading ~). Mirror of start.mjs::resolveClaudeConfigDir — inlined because
// postinstall ships as raw JS and cannot import the TS util. Without this,
// postinstall hardcoded ~/.claude while start.mjs + doctor honored the env
// var, so heal entries split-brained and a custom-config-dir user got an
// unwanted ~/.claude/ created (Issue #577 class). (Second-pass finding.)
function resolveClaudeConfigDir() {
  const envVal = process.env.CLAUDE_CONFIG_DIR;
  if (envVal && envVal.trim() !== "") {
    if (envVal.startsWith("~")) {
      return resolve(homedir(), envVal.replace(/^~[/\\]?/, ""));
    }
    return resolve(envVal);
  }
  return resolve(homedir(), ".claude");
}

// ── -2. Issue #564 — Linux SIGSEGV class hard-fail (v1.0.132) ────────
// On Linux + Node < 22.5 + no Bun, better-sqlite3's native addon is
// vulnerable to V8 calling `madvise(MADV_DONTNEED)` on memory ranges
// that overlap the addon's `.got.plt` section, corrupting resolved
// symbol addresses and causing sporadic SIGSEGV (1-4/hour) — see
// https://github.com/nodejs/node/issues/62515 and our internal #564.
//
// node:sqlite (built-in, no native addon, no .got.plt to corrupt) ships
// from Node 22.5 onward — that is the contract `hasModernSqlite()` in
// src/db-base.ts encodes. Six prior fixes (#228, #331, #461, #540,
// #551, #556) silently assumed users had Node >= 22.5 on Linux; #564
// is the second confirmed report (after #556) of the same SIGSEGV
// class on Node 20.
//
// The architect mandate for v1.0.132 is HARD-FAIL, not warn-then-
// degrade. `engines.node >= 22.5.0` in package.json is cosmetic under
// the default npm `engine-strict=false`, so the contract has to be
// enforced HERE — preinstall/postinstall is the only place that can
// `process.exit(1)` across npm/pnpm/yarn.
//
// Item C1 follow-up — the gate ALSO runs at preinstall via
// scripts/preinstall.mjs so unsupported runtimes abort BEFORE the dep
// tree downloads. Keep this postinstall call as belt-and-suspenders for
// the small population of installers that skip preinstall (some
// sandboxed CI runners, some pnpm modes). Single source of truth is
// scripts/lib/runtime-precheck.mjs.
//
// Linux + Bun is allowed through (bun:sqlite sidesteps better-sqlite3
// entirely). Non-Linux platforms are unaffected by the madvise bug
// and pass through unchanged.
runRuntimePrecheck({ phase: "postinstall" });

/**
 * True when running as a real `npm install -g context-mode`. We use this
 * to keep contributors' local `npm install` runs from rewriting their HOME's
 * Claude Code registry (would be very surprising during dev).
 *
 * Heuristic: npm sets `npm_config_global=true` for global installs AND the
 * package directory does not contain a `.git` (a contributor's clone always
 * does). Both signals must agree.
 *
 * Item DI-5 (docs/setup-improvements.md) — bound the walk to a single
 * level (pkgRoot only). The previous 4-level walk false-positive'd on
 * Devbox / Docker images where `/tmp/.git` exists from bootstrap scripts:
 * any tmpdir-staged install would skip the heal block silently. A real
 * contributor clone always has `.git` AT pkgRoot, never several levels
 * away, so depth 0 is sufficient. pnpm/yarn workspace-root `.git`
 * scenarios are already eliminated by the `npm_config_global` precondition
 * — `npm install` from a workspace does not set it.
 */
function isGlobalInstall() {
  if (process.env.npm_config_global !== "true") return false;
  if (existsSync(join(pkgRoot, ".git"))) return false;
  return true;
}

/**
 * Validate that a path is safe to interpolate into a cmd.exe command.
 * Rejects characters that could enable command injection via cmd.exe.
 */
function isSafeWindowsPath(p) {
  return !/[&|<>"^%\r\n]/.test(p);
}

// ── -1. Registry heal suite (Issues #46915 / #523 / #609 / etc.) ─────
// 4-layer heal block — healInstalledPlugins (#46915) + healSettingsEnabledPlugins
// (v1.0.116) + healPluginJsonMcpServers (#523) + sweepStaleMcpJson (#609).
// Same sequence runs on every MCP boot inside start.mjs, so users whose
// registry is poisoned (and therefore have no MCP to boot) can self-recover
// via `npm install -g context-mode`. Single source of truth lives in
// scripts/lib/heal/runtime-heal-suite.mjs — Item B of
// docs/setup-improvements.md. Only runs in real `npm install -g` so
// contributor `npm install` runs do not rewrite HOME's Claude Code registry.
if (isGlobalInstall()) {
  try {
    const report = runRuntimeHealSuite({
      pluginKey: "context-mode@context-mode",
      claudeConfigDir: resolveClaudeConfigDir(),
      phase: "postinstall",
    });
    if (report.healed.length > 0) {
      process.stderr.write(
        `context-mode: healed — ${report.healed.join("; ")}\n`,
      );
    } else if (report.skipped.includes("installed_plugins.json:no-registry")) {
      process.stderr.write("context-mode: install OK, no Claude Code registry found\n");
    } else if (report.errors.length > 0) {
      process.stderr.write(
        `context-mode: install OK, heal partially skipped (${report.errors.join("; ")})\n`,
      );
    } else {
      process.stderr.write("context-mode: install OK, no heal needed\n");
    }
  } catch (err) {
    // Never block install on a heal failure.
    try {
      process.stderr.write(
        `context-mode: install OK, heal aborted (${(err && err.message) || err})\n`,
      );
    } catch { /* truly best effort */ }
  }
}

// ── 0. Self-heal Layer 3: Backward symlink for stale registry (anthropics/claude-code#46915) ──
// When this install completes, installed_plugins.json may still point to an old
// non-existent path. Create a symlink from that old path → our new directory.
try {
  const ipPath = resolve(resolveClaudeConfigDir(), "plugins", "installed_plugins.json");
  if (existsSync(ipPath)) {
    const ip = JSON.parse(readFileSync(ipPath, "utf-8"));
    const cacheRoot = resolve(resolveClaudeConfigDir(), "plugins", "cache");
    for (const [key, entries] of Object.entries(ip.plugins || {})) {
      if (key !== "context-mode@context-mode") continue;
      for (const entry of entries) {
        const rp = entry.installPath;
        if (!rp || existsSync(rp)) continue;
        // Path traversal guard
        if (!resolve(rp).startsWith(cacheRoot + sep)) continue;
        // Remove dangling symlink
        try { if (lstatSync(rp).isSymbolicLink()) unlinkSync(rp); } catch {}
        const rpParent = dirname(rp);
        if (!existsSync(rpParent)) mkdirSync(rpParent, { recursive: true });
        try {
          symlinkSync(pkgRoot, rp, process.platform === "win32" ? "junction" : undefined);
        } catch { /* may fail if path is locked or permissions */ }
      }
    }
  }
} catch { /* best effort — don't block install */ }

// ── 1. OpenClaw detection ────────────────────────────────────────────
if (process.env.OPENCLAW_STATE_DIR) {
  console.log("\n  OpenClaw detected. Run: npm run install:openclaw\n");
}

// ── 2. Windows global install — nvm4w junction fix ───────────────────
// npm's .cmd shim resolves modules via %~dp0\node_modules\<pkg>\...
// On nvm4w the shim lives at C:\nvm4w\nodejs\ but node_modules is at
// C:\Users\<USER>\AppData\Roaming\npm\node_modules\. The relative path
// breaks because they're on different prefixes.
//
// Fix: detect the mismatch and create a directory junction so the shim
// can reach us through the expected relative path.

if (process.platform === "win32" && process.env.npm_config_global === "true") {
  try {
    // npm prefix is where both the .cmd shims and node_modules live
    // Use npm_config_prefix env (set during install) or fall back to `npm config get prefix`
    // Note: `npm bin -g` was removed in npm v9+, so we use prefix instead
    const prefix = (
      process.env.npm_config_prefix ||
      execSync("npm config get prefix", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim()
    );

    const actualPkgDir = pkgRoot;

    // npm's .cmd shim uses %~dp0\node_modules\<pkg>\... to find the entry point.
    // On nvm4w, stale shims at C:\nvm4w\nodejs\ may exist alongside correct ones
    // at the npm prefix. We create junctions at ALL known shim locations.
    const shimDirs = new Set([prefix]);

    // Detect stale shim locations via `where` command
    try {
      const whereOutput = execSync("where context-mode.cmd", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      for (const line of whereOutput.split(/\r?\n/)) {
        if (line.endsWith("context-mode.cmd")) {
          shimDirs.add(dirname(line));
        }
      }
    } catch { /* where may fail if not installed yet */ }

    for (const shimDir of shimDirs) {
      const expectedPkgDir = join(shimDir, "node_modules", "context-mode");

      if (
        resolve(expectedPkgDir).toLowerCase() !== resolve(actualPkgDir).toLowerCase() &&
        !existsSync(expectedPkgDir)
      ) {
        const expectedNodeModules = join(shimDir, "node_modules");
        if (!existsSync(expectedNodeModules)) {
          mkdirSync(expectedNodeModules, { recursive: true });
        }

        // Create directory junction (no admin privileges needed on Windows 10+)
        // Validate paths to prevent cmd.exe injection via shell metacharacters
        if (!isSafeWindowsPath(expectedPkgDir) || !isSafeWindowsPath(actualPkgDir)) {
          console.warn(`  context-mode: skipping junction — path contains unsafe characters`);
        } else {
          execSync(`mklink /J "${expectedPkgDir}" "${actualPkgDir}"`, {
            shell: "cmd.exe",
            stdio: "pipe",
          });
          console.log(`\n  context-mode: created junction for nvm4w compatibility`);
          console.log(`    ${expectedPkgDir} → ${actualPkgDir}\n`);
        }
      }
    }

    // Also fix stale shims that reference old bin entry (build/cli.js → cli.bundle.mjs)
    try {
      const whereOutput = execSync("where context-mode.cmd", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      for (const line of whereOutput.split(/\r?\n/)) {
        if (line.endsWith("context-mode.cmd")) {
          const content = readFileSync(line, "utf-8");
          if (content.includes("build\\cli.js") || content.includes("build/cli.js")) {
            // Rewrite stale shim to use cli.bundle.mjs
            const fixed = content
              .replace(/build[\\\/]cli\.js/g, "cli.bundle.mjs");
            writeFileSync(line, fixed);
            console.log(`  context-mode: fixed stale shim at ${line}`);
          }
        }
      }
    } catch { /* best effort */ }
  } catch {
    // Best effort — don't block install. User can use npx as fallback.
  }
}

// ── 3. Native binding self-heal — better-sqlite3 (#408) ──────────────
// On Windows, `npm rebuild` falls through to node-gyp without MSVC; bypass
// that by spawning prebuild-install directly. Cross-platform safety net —
// the binding can also go missing on macOS/Linux when prebuilds are stale
// or the install was interrupted.
//
// Logic lives in scripts/heal-better-sqlite3.mjs (shared with
// hooks/ensure-deps.mjs so there's one source of truth).
try { healBetterSqlite3Binding(pkgRoot); } catch { /* best effort — don't block install */ }

// ── 4. Hook normalization at install time (#414) ─────────────────────
// hooks/hooks.json + .claude-plugin/plugin.json ship with `${CLAUDE_PLUGIN_ROOT}`
// + bare `node` command. On Windows + Claude Code that combination triggers
// `cjs/loader:1479 MODULE_NOT_FOUND` (placeholder mangling, MSYS path issues,
// PATH lookup failure). start.mjs normalizes on every MCP boot, but normalizing
// here too closes the gap for the very first hook fire after a fresh install
// (before any MCP server has run).
//
// Guard 1: only run on REAL `npm install -g context-mode`. A contributor's
// `npm install` from a git clone (or CI checkout) must NOT mutate the
// source-tracked `.claude-plugin/plugin.json` — doing so substitutes the
// literal `${CLAUDE_PLUGIN_ROOT}` with an absolute path and trips
// `scripts/assert-asymmetric-drift.mjs` (Issue #531) in the build chain.
// Reuses `isGlobalInstall()` (section -1 already gates that way); the
// `.git` walk inside it is what keeps contributor / CI installs untouched.
//
// Guard 2: /ctx-upgrade clones the repo to `<tmpdir>/context-mode-upgrade-<epoch>/`
// and runs `npm install` there before `cpSync`-ing files into the real pluginRoot
// (src/cli.ts). The tmpdir has no `.git`, so `isGlobalInstall()` returns
// true there — we need this second check to skip the staging dir. Without
// it, pkgRoot is the tmpdir → hooks.json gets the tmpdir's absolute paths
// baked in → cpSync copies that poisoned hooks.json into the real plugin
// dir → tmpdir is later cleaned → every hook fires with MODULE_NOT_FOUND.
// start.mjs normalizes correctly on the next MCP boot from the real
// pluginRoot anyway.
const TMPDIR_UPGRADE_RE = /[/\\]context-mode-upgrade-\d+[/\\]?$/;
if (isGlobalInstall() && !TMPDIR_UPGRADE_RE.test(pkgRoot)) {
  try {
    const { normalizeHooksOnStartup } = await import("../hooks/normalize-hooks.mjs");
    normalizeHooksOnStartup({
      pluginRoot: pkgRoot,
      nodePath: process.execPath,
      platform: process.platform,
    });
  } catch { /* best effort — never block install */ }
}
