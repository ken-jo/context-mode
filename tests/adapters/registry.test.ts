/**
 * Matrix test for `src/adapters/registry.ts`.
 *
 * Locks in the single-source-of-truth contract introduced by Item D of
 * docs/setup-improvements.md: every adapter directory under `src/adapters/`
 * MUST have a registry entry, and every registry entry MUST resolve to a
 * working `HookAdapter` whose `name` matches a known platform.
 *
 * Without these assertions the legacy 3-place duplication (env-var map,
 * session-dir switch, adapter loader switch) can silently drift back —
 * issue #473 shipped because the `pi` case was missing from one of the
 * three places.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import {
  ADAPTER_REGISTRY,
  REGISTERED_PLATFORM_IDS,
  getRegistryEntry,
} from "../../src/adapters/registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTERS_DIR = resolve(__dirname, "..", "..", "src", "adapters");

/**
 * Directories that hold a real adapter module. `claude-code-base`,
 * `copilot-base` and `client-map` are shared utility files, not platforms.
 */
function readAdapterDirs(): string[] {
  return readdirSync(ADAPTERS_DIR).filter((name) => {
    const full = resolve(ADAPTERS_DIR, name);
    if (!statSync(full).isDirectory()) return false;
    // Shared base modules are not platforms.
    if (name.endsWith("-base")) return false;
    return true;
  });
}

describe("adapter registry", () => {
  it("registers exactly one entry per id, ids are unique", () => {
    const ids = ADAPTER_REGISTRY.map((e) => e.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("covers every adapter source directory", () => {
    // OpenCodeAdapter is shared between two platform ids (opencode + kilo)
    // — the directory count is 14 while the registry has 15 entries.
    const dirs = new Set(readAdapterDirs());
    const expectedDirs = new Set<string>();
    for (const entry of ADAPTER_REGISTRY) {
      // Reverse-resolve directory from platform id: kilo + opencode both
      // live under `opencode/`. Everything else maps 1:1.
      if (entry.id === "kilo") expectedDirs.add("opencode");
      else expectedDirs.add(entry.id);
    }
    expect([...dirs].sort()).toEqual([...expectedDirs].sort());
  });

  it("every registered id is looked up to itself", () => {
    for (const entry of ADAPTER_REGISTRY) {
      const found = getRegistryEntry(entry.id);
      expect(found).toBeDefined();
      expect(found?.id).toBe(entry.id);
    }
  });

  it("returns undefined for unknown ids", () => {
    expect(getRegistryEntry("unknown")).toBeUndefined();
    expect(getRegistryEntry("totally-made-up")).toBeUndefined();
  });

  it("REGISTERED_PLATFORM_IDS mirrors ADAPTER_REGISTRY", () => {
    expect(REGISTERED_PLATFORM_IDS.size).toBe(ADAPTER_REGISTRY.length);
    for (const entry of ADAPTER_REGISTRY) {
      expect(REGISTERED_PLATFORM_IDS.has(entry.id)).toBe(true);
    }
  });

  it("each loader resolves to an adapter with a name", async () => {
    for (const entry of ADAPTER_REGISTRY) {
      const adapter = await entry.load();
      expect(adapter.name, `loader for ${entry.id} returned nameless adapter`).toBeTruthy();
    }
  });

  it("sessionDirSegments are non-empty for every entry", () => {
    for (const entry of ADAPTER_REGISTRY) {
      expect(entry.sessionDirSegments.length).toBeGreaterThan(0);
    }
  });

  // Item D2 — envVars field is part of the contract.
  it("envVars is a typed array for every entry (empty allowed)", () => {
    for (const entry of ADAPTER_REGISTRY) {
      expect(Array.isArray(entry.envVars)).toBe(true);
      for (const v of entry.envVars) {
        expect(typeof v.name).toBe("string");
        expect(["workspace", "identification"]).toContain(v.role);
      }
    }
  });

  it("antigravity + cursor are listed BEFORE vscode-copilot (fork-precedence)", () => {
    const idx = (id: string) => ADAPTER_REGISTRY.findIndex((e) => e.id === id);
    const antigravity = idx("antigravity");
    const cursor = idx("cursor");
    const vsc = idx("vscode-copilot");
    expect(antigravity).toBeLessThan(vsc);
    expect(cursor).toBeLessThan(vsc);
  });

  it("kilo is listed BEFORE opencode (kilo is the opencode fork)", () => {
    const idx = (id: string) => ADAPTER_REGISTRY.findIndex((e) => e.id === id);
    expect(idx("kilo")).toBeLessThan(idx("opencode"));
  });

  it("omp is listed BEFORE pi (OMP-only marker disambiguates)", () => {
    const idx = (id: string) => ADAPTER_REGISTRY.findIndex((e) => e.id === id);
    expect(idx("omp")).toBeLessThan(idx("pi"));
  });
});
