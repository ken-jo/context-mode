/**
 * scripts/lib/runtime-precheck — shared SIGSEGV class hard-fail (Issue #564).
 *
 * Originally inlined in `scripts/postinstall.mjs`. Lifted here so a sibling
 * `scripts/preinstall.mjs` can run the same gate BEFORE npm starts
 * downloading the dependency tree — saves ~30MB / ~10s on every install
 * that would have aborted anyway. postinstall keeps the call as
 * belt-and-suspenders for the small population of installers that ignore
 * `preinstall` hooks (some sandboxed CI runners, some pnpm modes).
 *
 * Implements Item C1 + C3 of docs/setup-improvements.md.
 */

/**
 * Detect the package manager that invoked this script. Returns one of
 * "npm" | "pnpm" | "yarn" | "bun" | "unknown". Used only to print the
 * right remediation hint — never gates behavior.
 *
 * Item C3 — derived from npm-style env vars set by every modern manager
 * (npm_config_user_agent is the canonical signal; npm_execpath is a
 * stronger anchor on yarn classic and pnpm). Bun sets process.versions.bun
 * regardless of whether install ran through bun add — keep that check last
 * so it does not mask the actual installer that launched the script.
 */
export function detectPackageManager() {
  const ua = process.env.npm_config_user_agent ?? "";
  if (ua.startsWith("pnpm/")) return "pnpm";
  if (ua.startsWith("yarn/")) return "yarn";
  if (ua.startsWith("bun/")) return "bun";
  if (ua.startsWith("npm/")) return "npm";
  const exec = process.env.npm_execpath ?? "";
  if (/pnpm/i.test(exec)) return "pnpm";
  if (/yarn/i.test(exec)) return "yarn";
  if (/bun/i.test(exec)) return "bun";
  if (/npm/i.test(exec)) return "npm";
  if (typeof process.versions?.bun === "string") return "bun";
  return "unknown";
}

/**
 * Map package-manager id → the canonical "install context-mode globally"
 * command for that manager. Surfaced in the SIGSEGV remediation block.
 */
function globalInstallHint(pm) {
  switch (pm) {
    case "pnpm":  return "pnpm add -g context-mode";
    case "yarn":  return "yarn global add context-mode";
    case "bun":   return "bun add -g context-mode";
    case "npm":   return "npm install -g context-mode";
    default:      return "npm install -g context-mode";
  }
}

/**
 * Issue #564 — Linux + Node < 22.5 hard-fail.
 *
 * On Linux + Node < 22.5 + no Bun, better-sqlite3's native addon is
 * vulnerable to V8 calling `madvise(MADV_DONTNEED)` on memory ranges
 * that overlap the addon's `.got.plt` section, corrupting resolved
 * symbol addresses and causing sporadic SIGSEGV (1-4/hour). See
 * https://github.com/nodejs/node/issues/62515 and our internal #564.
 *
 * node:sqlite (built-in, no native addon, no .got.plt to corrupt) ships
 * from Node 22.5 onward. Linux + Bun is allowed through (bun:sqlite
 * sidesteps better-sqlite3 entirely). Non-Linux platforms are unaffected.
 *
 * @param {{ phase?: "preinstall" | "postinstall" }} [opts]
 * @returns {void} - calls `process.exit(1)` on unsupported runtimes.
 */
export function runRuntimePrecheck(opts = {}) {
  const phase = opts.phase ?? "postinstall";
  const isLinux = process.platform === "linux";
  const hasBun =
    typeof globalThis.Bun !== "undefined" ||
    typeof process.versions.bun === "string";
  const [majStr, minStr] = (process.versions.node ?? "0.0.0").split(".");
  const major = Number(majStr);
  const minor = Number(minStr);
  const hasModernNode =
    Number.isFinite(major) &&
    Number.isFinite(minor) &&
    (major > 22 || (major === 22 && minor >= 5));
  if (!isLinux || hasBun || hasModernNode) return;

  const pm = detectPackageManager();
  const hint = globalInstallHint(pm);
  const pmLabel = pm === "unknown" ? "npm" : pm;

  process.stderr.write(
    "\n" +
    `context-mode: install aborted at ${phase}\n` +
    "  Linux + Node " + (process.versions.node ?? "?") + " is unsupported.\n" +
    "  context-mode requires Node.js >= 22.5 (or Bun) on Linux to avoid the\n" +
    "  V8 madvise(MADV_DONTNEED) SIGSEGV affecting better-sqlite3 (1-4/hour).\n" +
    "  Tracking: https://github.com/nodejs/node/issues/62515\n" +
    "           https://github.com/mksglu/context-mode/issues/564\n" +
    "\n" +
    `  Detected package manager: ${pmLabel}\n` +
    "\n" +
    "  Fix: upgrade Node (recommended)\n" +
    "    nvm install 22.5 && nvm use 22.5\n" +
    `    ${hint}\n` +
    "\n" +
    "  Or: run under Bun\n" +
    "    curl -fsSL https://bun.sh/install | bash\n" +
    "    bun add -g context-mode\n" +
    "\n",
  );
  process.exit(1);
}
