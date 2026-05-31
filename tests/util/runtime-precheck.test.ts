/**
 * Issue #564 — `scripts/lib/runtime-precheck.mjs` MUST hard-fail on
 * Linux + Node < 22.5 + no Bun, and MUST pass through everywhere else.
 *
 * Item C1 of docs/setup-improvements.md introduces a preinstall call site
 * that shares this helper with postinstall. This test pins the behavior
 * matrix so a refactor cannot silently downgrade the gate to warn-only.
 *
 * The helper reads process.platform + process.versions.node + globalThis.Bun
 * at call time, so the test patches those rather than spawning subprocesses.
 */

import { describe, test, expect, vi, afterEach } from "vitest";
import {
  detectPackageManager,
  runRuntimePrecheck,
} from "../../scripts/lib/runtime-precheck.mjs";

/** Snapshot + restore process descriptors mutated per-test. */
function patchProcess(opts: {
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  bun?: boolean;
}) {
  const originals: Record<string, PropertyDescriptor | undefined> = {};
  if (opts.platform !== undefined) {
    originals.platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: opts.platform, configurable: true });
  }
  if (opts.nodeVersion !== undefined) {
    originals.versions = Object.getOwnPropertyDescriptor(process, "versions");
    Object.defineProperty(process, "versions", {
      value: { ...process.versions, node: opts.nodeVersion },
      configurable: true,
    });
  }
  if (opts.bun === true && typeof (globalThis as unknown as { Bun?: unknown }).Bun === "undefined") {
    (globalThis as unknown as { Bun?: unknown }).Bun = { version: "1.0.0" };
  }
  return () => {
    for (const [key, desc] of Object.entries(originals)) {
      if (desc) Object.defineProperty(process, key, desc);
    }
    if (opts.bun === true) {
      delete (globalThis as unknown as { Bun?: unknown }).Bun;
    }
  };
}

describe("runRuntimePrecheck", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let restores: Array<() => void> = [];

  afterEach(() => {
    exitSpy?.mockRestore();
    stderrSpy?.mockRestore();
    for (const r of restores) r();
    restores = [];
  });

  test("passes through on macOS regardless of Node version", () => {
    restores.push(patchProcess({ platform: "darwin", nodeVersion: "20.0.0" }));
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("should not exit");
    }) as never);
    expect(() => runRuntimePrecheck()).not.toThrow();
  });

  test("passes through on Windows regardless of Node version", () => {
    restores.push(patchProcess({ platform: "win32", nodeVersion: "18.0.0" }));
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("should not exit");
    }) as never);
    expect(() => runRuntimePrecheck()).not.toThrow();
  });

  test("passes through on Linux with Node >= 22.5", () => {
    restores.push(patchProcess({ platform: "linux", nodeVersion: "22.5.0" }));
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("should not exit");
    }) as never);
    expect(() => runRuntimePrecheck()).not.toThrow();
  });

  test("passes through on Linux with Node 22.6", () => {
    restores.push(patchProcess({ platform: "linux", nodeVersion: "22.6.1" }));
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("should not exit");
    }) as never);
    expect(() => runRuntimePrecheck()).not.toThrow();
  });

  test("passes through on Linux + Node 20 when Bun is present", () => {
    restores.push(patchProcess({ platform: "linux", nodeVersion: "20.0.0", bun: true }));
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("should not exit");
    }) as never);
    expect(() => runRuntimePrecheck()).not.toThrow();
  });

  test("hard-fails on Linux + Node 20 (no Bun) — Issue #564", () => {
    restores.push(patchProcess({ platform: "linux", nodeVersion: "20.10.0" }));
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit-called");
    }) as never);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(() => runRuntimePrecheck()).toThrow("exit-called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const written = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(written).toContain("install aborted");
    expect(written).toContain("issues/564");
    expect(written).toContain("nvm install 22.5");
  });

  test("hard-fails on Linux + Node 22.4 (boundary case)", () => {
    restores.push(patchProcess({ platform: "linux", nodeVersion: "22.4.99" }));
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit-called");
    }) as never);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(() => runRuntimePrecheck()).toThrow("exit-called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("phase label appears in the abort message", () => {
    restores.push(patchProcess({ platform: "linux", nodeVersion: "20.0.0" }));
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit-called");
    }) as never);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(() => runRuntimePrecheck({ phase: "preinstall" })).toThrow("exit-called");
    const written = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(written).toContain("install aborted at preinstall");
  });
});

describe("detectPackageManager", () => {
  const origUa = process.env.npm_config_user_agent;
  const origExec = process.env.npm_execpath;

  afterEach(() => {
    if (origUa === undefined) delete process.env.npm_config_user_agent;
    else process.env.npm_config_user_agent = origUa;
    if (origExec === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = origExec;
  });

  test("detects npm from user-agent", () => {
    process.env.npm_config_user_agent = "npm/10.5.0 node/v22.5.0 darwin x64";
    delete process.env.npm_execpath;
    expect(detectPackageManager()).toBe("npm");
  });

  test("detects pnpm from user-agent", () => {
    process.env.npm_config_user_agent = "pnpm/9.0.0 npm/?";
    delete process.env.npm_execpath;
    expect(detectPackageManager()).toBe("pnpm");
  });

  test("detects yarn from user-agent", () => {
    process.env.npm_config_user_agent = "yarn/1.22.0";
    delete process.env.npm_execpath;
    expect(detectPackageManager()).toBe("yarn");
  });

  test("detects bun from user-agent", () => {
    process.env.npm_config_user_agent = "bun/1.0.0";
    delete process.env.npm_execpath;
    expect(detectPackageManager()).toBe("bun");
  });

  test("falls back to execpath when user-agent is missing", () => {
    delete process.env.npm_config_user_agent;
    process.env.npm_execpath = "/usr/local/bin/pnpm/bin/pnpm.cjs";
    expect(detectPackageManager()).toBe("pnpm");
  });

  test("returns unknown when neither signal is present", () => {
    delete process.env.npm_config_user_agent;
    delete process.env.npm_execpath;
    // Note: Bun global may be present in some test envs; if so, function returns "bun".
    // That's correct behavior — included by the spec.
    const got = detectPackageManager();
    expect(["unknown", "bun"]).toContain(got);
  });
});
