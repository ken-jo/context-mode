/**
 * Regression for the partial-install masking bug.
 *
 * When an interrupted `/ctx-upgrade` swap leaves the active plugin-cache dir
 * half-populated, the integrity helper itself
 * (`scripts/plugin-cache-integrity.mjs`, shipped in package.json files[]) can
 * be among the missing files. The doctor then reported only
 * "integrity helper unavailable", masking the real breakage: the MCP launch
 * entrypoint (`start.mjs` / server bundle) was also gone, so
 * `node ${CLAUDE_PLUGIN_ROOT}/start.mjs` failed and the MCP server never
 * started.
 *
 * `findMissingLaunchFiles` is a dependency-free (fs-only) check that surfaces
 * exactly which launch files are absent, so the diagnostic stays useful even
 * when the integrity helper module cannot load.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findMissingLaunchFiles } from "../../src/util/plugin-cache-integrity.js";

describe("findMissingLaunchFiles", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ctx-launch-files-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const touch = (rel: string): void => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "");
  };

  it("returns [] when start.mjs and server.bundle.mjs are present", () => {
    touch("start.mjs");
    touch("server.bundle.mjs");
    expect(findMissingLaunchFiles(root)).toEqual([]);
  });

  it("flags a missing start.mjs (the no-fallback command entrypoint)", () => {
    touch("server.bundle.mjs");
    expect(findMissingLaunchFiles(root)).toEqual(["start.mjs"]);
  });

  it("accepts build/server.js as the server fallback (no false positive)", () => {
    touch("start.mjs");
    touch("build/server.js"); // server.bundle.mjs absent, but fallback present
    expect(findMissingLaunchFiles(root)).toEqual([]);
  });

  it("flags the server only when BOTH server.bundle.mjs and build/server.js are absent", () => {
    touch("start.mjs");
    expect(findMissingLaunchFiles(root)).toEqual([
      "server.bundle.mjs (or build/server.js)",
    ]);
  });

  it("reports every missing launch file for a fully empty (partial) install", () => {
    // Reproduces the observed broken cache: neither the entrypoint nor the
    // server bundle was copied by the interrupted swap.
    expect(findMissingLaunchFiles(root)).toEqual([
      "start.mjs",
      "server.bundle.mjs (or build/server.js)",
    ]);
  });
});
