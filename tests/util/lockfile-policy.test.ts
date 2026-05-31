/**
 * Lockfile policy contract (Item F1 follow-up).
 *
 * The maintainer's stated stance is: `bun.lock` is the source of truth,
 * `package-lock.json` is intentionally `.gitignore`d. npm users get
 * whatever npm resolves — that's accepted and documented in README's
 * Build Prerequisites section.
 *
 * These tests lock in that policy so a well-meaning contributor doesn't
 * silently add `package-lock.json` to git (or vice-versa: rip out
 * `bun.lock` and break reproducible installs for Bun users).
 *
 * If the policy changes, update both this test and `.gitignore`.
 */

import { describe, test, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

describe("lockfile policy", () => {
  test("bun.lock is the tracked SOT lockfile", () => {
    expect(existsSync(resolve(REPO_ROOT, "bun.lock"))).toBe(true);
  });

  test("package-lock.json is gitignored (by design)", () => {
    const gitignore = readFileSync(resolve(REPO_ROOT, ".gitignore"), "utf-8");
    // The line MUST match exactly so a partial-path entry doesn't satisfy
    // the assertion (e.g. `node_modules/package-lock.json`).
    const lines = gitignore.split(/\r?\n/).map((l) => l.trim());
    expect(lines).toContain("package-lock.json");
  });

  test("pnpm-lock.yaml is NOT tracked (maintainer-aware policy)", () => {
    // pnpm is not on the maintainer's supported manager list. Keep the
    // tree free of a stray lockfile that would confuse users about which
    // resolver is authoritative.
    expect(existsSync(resolve(REPO_ROOT, "pnpm-lock.yaml"))).toBe(false);
  });
});
