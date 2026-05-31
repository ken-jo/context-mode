/**
 * Item E2 of docs/setup-improvements.md — surface routing-fidelity honesty
 * for MCP-only paradigm hosts (antigravity, zed).
 *
 * Antigravity + Zed have NO hook surface. Routing relies on a rules file
 * (AGENTS.md / GEMINI.md), which the model follows ~60% of the time per
 * upstream measurements. Both `setup` and `doctor` MUST tell the user
 * this so "Setup complete" / "Doctor PASS" don't get mistaken for
 * hook-grade enforcement.
 *
 * Static-analysis guard against silent regression — same pattern as the
 * other contract tests under tests/cli/ and tests/util/.
 */

import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const cliSrc = readFileSync(resolve(REPO_ROOT, "src", "cli.ts"), "utf-8");
const setupSrc = readFileSync(resolve(REPO_ROOT, "src", "setup.ts"), "utf-8");

describe("MCP-only routing honesty (Item E2)", () => {
  test("doctor warns about ~60% fidelity for mcp-only paradigm", () => {
    // The warn must reference the paradigm signal so it stays accurate
    // when adapter #16 with `mcp-only` paradigm joins.
    expect(cliSrc).toMatch(/paradigm\s*===?\s*["']mcp-only["']/);
    // The fidelity number and the phrase "best-effort" must appear in
    // the same neighborhood as the paradigm check.
    const idx = cliSrc.search(/paradigm\s*===?\s*["']mcp-only["']/);
    expect(idx).toBeGreaterThan(-1);
    const window = cliSrc.slice(idx, idx + 600);
    expect(window).toMatch(/best-effort/i);
    expect(window).toMatch(/60%/);
  });

  test("setup warns about ~60% fidelity for mcp-only paradigm", () => {
    // setup uses a static MCP_ONLY_PARADIGM set (it has the platform id,
    // not the adapter instance, at warn time).
    expect(setupSrc).toMatch(/MCP_ONLY_PARADIGM/);
    expect(setupSrc).toMatch(/best-effort/i);
    expect(setupSrc).toMatch(/60%/);
    // Both antigravity and zed must be members.
    const setMatch = setupSrc.match(/MCP_ONLY_PARADIGM[^=]*=\s*new\s+Set\(\[([^\]]+)\]\)/);
    expect(setMatch).not.toBeNull();
    const members = setMatch?.[1] ?? "";
    expect(members).toMatch(/"antigravity"|'antigravity'/);
    expect(members).toMatch(/"zed"|'zed'/);
  });
});
