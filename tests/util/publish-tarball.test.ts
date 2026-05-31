/**
 * Publish hygiene — Item F2 of docs/setup-improvements.md.
 *
 * Runs `npm pack --dry-run --json` and asserts the tarball:
 *   1. SHIPS every boot-critical file (start.mjs, cli.bundle.mjs,
 *      server.bundle.mjs, scripts/preinstall.mjs, scripts/postinstall.mjs,
 *      scripts/lib/runtime-precheck.mjs, .npmrc).
 *   2. DOES NOT ship dev-only paths (tests/, vitest.config, tsconfig.json,
 *      bun.lock, src/) — these waste install bandwidth and confuse users
 *      who poke around in node_modules.
 *
 * Runs `npm pack --dry-run` in-process (no actual tarball write). Slow
 * for an integration suite (~2-3s) but cheap relative to a regression
 * shipping a 5MB bundle.
 */

import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

interface PackResult {
  size: number;
  unpackedSize: number;
  entryCount: number;
  files: Array<{ path: string; size: number }>;
}

function pack(): PackResult {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 60_000,
    // npm prints JSON only when stderr is captured silently.
    stdio: ["pipe", "pipe", "pipe"],
  });
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

describe("publish tarball hygiene (Item F2)", () => {
  const result = pack();
  const paths = new Set(result.files.map((f) => f.path));

  const REQUIRED: ReadonlyArray<string> = [
    "package.json",
    "README.md",
    "LICENSE",
    "start.mjs",
    "cli.bundle.mjs",
    "server.bundle.mjs",
    "scripts/preinstall.mjs",
    "scripts/postinstall.mjs",
    "scripts/lib/runtime-precheck.mjs",
    "scripts/lib/heal/runtime-heal-suite.mjs",
    "scripts/lib/heal/heal-log.mjs",
    "scripts/heal-installed-plugins.mjs",
    "scripts/heal-better-sqlite3.mjs",
    "scripts/plugin-cache-integrity.mjs",
    // .npmrc intentionally NOT shipped — npm strips it from every tarball
    // for security (a published .npmrc would mutate the consumer's npm
    // config). Project-local engine-strict still applies to contributors;
    // published consumers fall through to `engines.node` + preinstall.
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".openclaw-plugin/openclaw.plugin.json",
    "hooks/hooks.json",
  ];

  const FORBIDDEN: ReadonlyArray<string> = [
    "tsconfig.json",
    "vitest.config.ts",
    "bun.lock",
    "package-lock.json",
    "src/cli.ts",
    "src/server.ts",
    "tests/setup/setup.test.ts",
    "BENCHMARK.md",
    "CONTRIBUTING.md",
    "CLAUDE.md",
  ];

  for (const required of REQUIRED) {
    test(`ships ${required}`, () => {
      expect(paths.has(required), `tarball missing ${required}`).toBe(true);
    });
  }

  for (const forbidden of FORBIDDEN) {
    test(`does NOT ship ${forbidden}`, () => {
      expect(paths.has(forbidden), `tarball contains forbidden ${forbidden}`).toBe(false);
    });
  }

  test("no test/ paths leak", () => {
    const testPaths = result.files.filter((f) =>
      /^tests?\//.test(f.path) || /\.test\.[tj]sx?$/.test(f.path),
    );
    expect(testPaths, `unexpected test paths: ${testPaths.map((f) => f.path).join(", ")}`).toEqual([]);
  });

  test("no src/ paths leak (we ship bundles, not TypeScript sources)", () => {
    const srcPaths = result.files.filter((f) => f.path.startsWith("src/"));
    expect(srcPaths, `unexpected src paths: ${srcPaths.map((f) => f.path).join(", ")}`).toEqual([]);
  });

  test("tarball stays under a sane size budget (5 MB packed)", () => {
    // Today ~600KB. The 5MB ceiling catches accidentally bundling
    // node_modules, fixtures, or large binaries.
    expect(result.size).toBeLessThan(5 * 1024 * 1024);
  });

  test("file count stays under a sane budget (600 files)", () => {
    // A fully-built tree (prepublishOnly runs `npm run build`, which emits
    // ~158 files into build/ that files[] ships) packs to ~318 files. The
    // 600 ceiling still catches accidental globbing (e.g. files[] widening to
    // "**/*.mjs" or shipping node_modules) without flaking on whether build/
    // happens to be populated when the test runs. (Loop-1 calibration: the
    // old 300 budget was measured against an UNBUILT tree.)
    expect(result.entryCount).toBeLessThan(600);
  });
});
