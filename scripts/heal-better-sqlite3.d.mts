/**
 * Type declarations for scripts/heal-better-sqlite3.mjs — the JS helper
 * called from both postinstall (cross-platform binding self-heal) and
 * src/cli.ts (doctor's binding-presence diagnostic).
 *
 * The runtime source stays as plain `.mjs` so postinstall can import it
 * without a TS toolchain dependency. This `.d.mts` lets the TS-side
 * caller drop its `@ts-expect-error` suppression.
 */

export function healBetterSqlite3Binding(pkgRoot: string): void;

export function detectWindowsVsYear(
  deps?: {
    platform?: NodeJS.Platform;
    existsSync?: (p: string) => boolean;
    exec?: (cmd: string, opts: object) => string;
  },
): string | null;
