/**
 * cli.ts upgrade-flow verification — v1.0.114 hotfix.
 *
 * The bug being fixed: /ctx-upgrade in v1.0.113 wrote registry version
 * "1.0.113" while the cache install dir on disk still carried plugin.json
 * version "1.0.112" (in-place files-array drift). Claude Code's plugin
 * loader rejected the manifest mismatch and silently disconnected the
 * plugin. The user has no MCP, so /ctx-upgrade can't even retry.
 *
 * Defense-in-depth wired into the upgrade flow:
 *   1. start.mjs MUST wire HEAL 3 + HEAL 4 from healInstalledPlugins
 *      (already-broken users self-recover on next MCP boot).
 *   2. src/cli.ts upgrade() MUST verify pluginRoot's plugin.json reports
 *      newVersion BEFORE bumping the registry (preflight gate).
 *   3. src/cli.ts upgrade() MUST re-read installed_plugins.json AFTER
 *      bumping and assert installPath/.claude-plugin/plugin.json's
 *      version matches the registry — throws on mismatch.
 *   4. src/cli.ts upgrade() MUST verify the marketplace clone (if
 *      present) was actually pulled to newVersion — Mert's case showed
 *      the clone stuck at v1.0.89 while npm published v1.0.113.
 *
 * Cross-OS / registry-format reference:
 *   refs/platforms/oh-my-pi/packages/coding-agent/test/marketplace/registry.test.ts:257-272
 *     installed_plugins.json shape: { version: 2, plugins: { key: Entry[] } }
 *   refs/platforms/codex/codex-rs/app-server/src/config/external_agent_config_tests.rs:808
 *     settings.json `enabledPlugins` is `{key: bool}` (cross-platform contract)
 */

import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

const cliSrc = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");
const startSrc = readFileSync(resolve(ROOT, "start.mjs"), "utf-8");
const upgradeIdx = cliSrc.indexOf("async function upgrade");
// upgradeBody cap was 14000 at v1.0.114; the function has grown by ~10k chars
// through #523/#531/#542 (Layer 5b heal, Layer 6 mcp.json heal, Pi/OMP detect).
// CI run 25739349791 showed the cap truncating the `Run manually: git -C ...
// fetch ... reset` one-liner at offset 14073 — 73 chars past the cap. The
// "marketplace assertion provides a manual-fix one-liner" test then sliced
// `assertIdx + 1000` and got a short 243-char buffer that ended mid-string at
// `... marketplaceDir"} fe` (regex needs `fetch ... reset`, both cut off).
// 30000 contains the full ~24k-char upgrade() body plus 6k buffer for future
// growth. Cheaper than dynamically detecting function boundaries; safe because
// every test using upgradeBody asserts on CONTENTS, never on .length.
const upgradeBody = cliSrc.slice(upgradeIdx, upgradeIdx + 30000);

// ─────────────────────────────────────────────────────────
// start.mjs wires HEAL 3 + HEAL 4 (Change 1)
// ─────────────────────────────────────────────────────────

describe("start.mjs registry-heal-suite wiring (v1.0.114 hotfix; SOT-consolidated)", () => {
  // Item B consolidated the inline HEAL 3/4/5b/5c blocks into
  // scripts/lib/heal/runtime-heal-suite.mjs (runRuntimeHealSuite). start.mjs
  // now CALLS the suite instead of inlining the loops; the suite imports the
  // shared healers. These assertions track the SOT wiring.
  test("imports + calls runRuntimeHealSuite from the shared suite module", () => {
    expect(startSrc).toMatch(/runtime-heal-suite/);
    expect(startSrc).toContain("runRuntimeHealSuite");
    expect(startSrc).toMatch(/runRuntimeHealSuite\(/);
  });

  test("the suite itself imports the shared heal healers", () => {
    const suiteSrc = readFileSync(
      resolve(ROOT, "scripts", "lib", "heal", "runtime-heal-suite.mjs"),
      "utf-8",
    );
    expect(suiteSrc).toMatch(/heal-installed-plugins\.mjs/);
    expect(suiteSrc).toContain("healInstalledPlugins");
  });

  test("the suite call is wrapped in defensive try/catch (never blocks MCP boot)", () => {
    const idx = startSrc.indexOf("runRuntimeHealSuite(");
    const block = startSrc.slice(Math.max(0, idx - 300), idx + 300);
    expect((block.match(/try\s*\{/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(block).toMatch(/never block MCP boot|best effort/i);
  });

  test("passes the resolved CLAUDE_CONFIG_DIR + plugin key into the suite", () => {
    const idx = startSrc.indexOf("runRuntimeHealSuite(");
    const block = startSrc.slice(idx, idx + 300);
    expect(block).toMatch(/resolveClaudeConfigDir\(\)/);
    expect(block).toContain('"context-mode@context-mode"');
  });
});

// ─────────────────────────────────────────────────────────
// cli.ts upgrade() — Change 2 — preflight, post-write, marketplace assertions
// ─────────────────────────────────────────────────────────

describe("cli.ts upgrade() pre-bump verification (v1.0.114 hotfix)", () => {
  test("reads pluginRoot/.claude-plugin/plugin.json BEFORE updatePluginRegistry", () => {
    const manifestIdx = upgradeBody.indexOf(".claude-plugin");
    const updateIdx = upgradeBody.indexOf("updatePluginRegistry");
    expect(manifestIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(-1);
    expect(manifestIdx).toBeLessThan(updateIdx);
  });

  test("throws when pluginRoot's plugin.json version disagrees with newVersion", () => {
    // The throw must mention the mismatch — surfacing the bug, not silently fixing.
    expect(upgradeBody).toMatch(
      /pluginRoot manifest version mismatch|Refusing to bump registry/,
    );
  });

  test("the throw appears between the in-place copy and updatePluginRegistry", () => {
    const stopIdx = upgradeBody.indexOf("Updated in-place to v");
    const throwIdx = upgradeBody.indexOf("Refusing to bump registry");
    const updateIdx = upgradeBody.indexOf("updatePluginRegistry");
    expect(stopIdx).toBeLessThan(throwIdx);
    expect(throwIdx).toBeLessThan(updateIdx);
  });

  test("upgrade() gates 'npm install -g' behind the opencode/kilo exclusion (PR #650)", () => {
    const upgradeIdx = cliSrc.indexOf("async function upgrade");
    const upgradeBody = cliSrc.slice(upgradeIdx, upgradeIdx + 30000);

    const gateIdx = upgradeBody.indexOf("!isInProcessPluginPlatform(detection.platform)");
    const npmGIdx = upgradeBody.indexOf('"install", "-g"');

    // Gate must exist, and the '-g' call must sit AFTER it (i.e. inside the block).
    expect(gateIdx).toBeGreaterThan(0);
    expect(npmGIdx).toBeGreaterThan(gateIdx);

    // The closing brace of the gate must come AFTER the '-g' call,
    // not between the ABI verifier and the global install (the pre-PR shape).
    const closeBefore = upgradeBody.lastIndexOf(
      "      }",
      upgradeBody.indexOf("// Cleanup"),
    );
    expect(closeBefore).toBeGreaterThan(npmGIdx);
  });
});

describe("cli.ts upgrade() post-write registry consistency check (v1.0.114 hotfix)", () => {
  test("re-reads installed_plugins.json after updatePluginRegistry", () => {
    const updateIdx = upgradeBody.indexOf("updatePluginRegistry");
    const recheckIdx = upgradeBody.indexOf("Registry consistency check");
    expect(updateIdx).toBeGreaterThan(-1);
    expect(recheckIdx).toBeGreaterThan(-1);
    expect(recheckIdx).toBeGreaterThan(updateIdx);
  });

  test("throws on installPath that does not exist on disk", () => {
    expect(upgradeBody).toContain("installPath does not exist on disk");
  });

  test("throws on missing plugin.json manifest under installPath", () => {
    expect(upgradeBody).toMatch(/missing plugin\.json manifest/);
  });

  test("throws on version mismatch between registry and on-disk plugin.json", () => {
    // Must call out BOTH the registry version and the on-disk version so
    // the error message tells the user exactly what drifted.
    expect(upgradeBody).toMatch(
      /version mismatch.*registry.*plugin\.json|registry says.*but.*says/,
    );
  });

  test("post-write check reads from resolveClaudeConfigDir()", () => {
    // Must honor $CLAUDE_CONFIG_DIR (#460 round-3) so users with relocated
    // CC config dirs are still verified correctly. The resolveClaudeConfigDir
    // call lives in the post-write block — slice from updatePluginRegistry
    // onward so we include the full check body.
    const updateIdx = upgradeBody.indexOf("updatePluginRegistry");
    const recheckEnd = upgradeBody.indexOf("Marketplace clone version mismatch");
    const block = upgradeBody.slice(updateIdx, recheckEnd);
    expect(block).toMatch(/resolveClaudeConfigDir\(\)/);
  });
});

describe("cli.ts upgrade() marketplace post-pull assertion (v1.0.114 hotfix)", () => {
  test("verifies marketplace clone's plugin.json version matches newVersion", () => {
    expect(upgradeBody).toMatch(/Marketplace clone version mismatch|marketplace.*plugin\.json/i);
  });

  test("marketplace assertion runs AFTER the marketplace sync block", () => {
    const syncIdx = upgradeBody.indexOf("Marketplace clone synced");
    const assertIdx = upgradeBody.indexOf("Marketplace clone version mismatch");
    expect(syncIdx).toBeGreaterThan(-1);
    expect(assertIdx).toBeGreaterThan(-1);
    expect(assertIdx).toBeGreaterThan(syncIdx);
  });

  test("marketplace mismatch warns (does NOT throw) — npm-only users have no clone", () => {
    // A throw inside upgrade() would abort the rest of the flow; warn keeps
    // upgrade going so the cache install — the actually-loaded path — is
    // still completed for users without a marketplace clone.
    // The warn appears inside the marketplace assertion block; slice from
    // the assertion start to end of upgrade body capture so we cover both
    // the warn-string flow and any catch-block fallback.
    const assertIdx = upgradeBody.indexOf("marketplace post-pull assertion");
    const block = upgradeBody.slice(assertIdx, assertIdx + 2000);
    expect(block).toMatch(/p\.log\.warn/);
    expect(block).not.toMatch(/throw new Error/);
  });

  test("marketplace assertion provides a manual-fix one-liner", () => {
    const assertIdx = upgradeBody.indexOf("Marketplace clone version mismatch");
    const block = upgradeBody.slice(assertIdx, assertIdx + 1000);
    expect(block).toMatch(/git.*-C.*marketplaceDir.*fetch.*reset/);
  });
});

// ─────────────────────────────────────────────────────────
// End-to-end: bug-prevention contract
// ─────────────────────────────────────────────────────────

describe("v1.0.114 hotfix — full bug-prevention contract", () => {
  test("upgrade() now CANNOT silently leave registry+disk in disagreement", () => {
    // The upgrade flow must contain BOTH preflight (pre-write) AND
    // post-write checks. Either alone is insufficient — preflight protects
    // against in-place copy races, post-write protects against adapter
    // misbehavior.
    const stopIdx = upgradeBody.indexOf("Updated in-place to v");
    const preflightIdx = upgradeBody.indexOf("Refusing to bump registry");
    const updateIdx = upgradeBody.indexOf("updatePluginRegistry");
    const postIdx = upgradeBody.indexOf("Registry consistency check");
    expect(stopIdx).toBeGreaterThan(-1);
    expect(preflightIdx).toBeGreaterThan(stopIdx);
    expect(updateIdx).toBeGreaterThan(preflightIdx);
    expect(postIdx).toBeGreaterThan(updateIdx);
  });

  test("start.mjs heal wiring + cli.ts assertions cite the hotfix lineage", () => {
    // Post-SOT: the inline "HEAL 3/4" labels moved into runtime-heal-suite.mjs;
    // start.mjs now references the suite. Accept either the suite wiring or the
    // legacy labels so the citation test tracks the consolidation.
    expect(startSrc).toMatch(/runtime-heal-suite|HEAL 3|HEAL 4|registry heal/i);
    expect(upgradeBody).toMatch(/v1\.0\.114|hotfix/);
  });
});
