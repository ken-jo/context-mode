/**
 * Type declarations for scripts/lib/heal/heal-log.mjs (Item B4).
 *
 * Sibling to runtime-heal-suite.mjs — both are imported from the
 * TypeScript src/cli.ts doctor flow as well as from the runtime
 * heal suite. Plain `.mjs` so postinstall + start.mjs can import
 * them without a TS toolchain; this `.d.mts` keeps the TS callers
 * type-safe.
 */

export interface HealLogEntry {
  ts: string;
  phase: "postinstall" | "mcp-boot";
  healed: string[];
  skipped: string[];
  errors: string[];
  sweptCount: number;
}

export interface HealLogSummary {
  total: number;
  healed: number;
  skippedOnly: number;
  errors: number;
  swept: number;
  lastPhases: Record<string, number>;
}

export function appendHealLog(opts: {
  claudeConfigDir: string;
  entry: Omit<HealLogEntry, "ts"> & { ts?: string };
}): void;

export function readHealLog(opts: {
  claudeConfigDir: string;
  sinceMs?: number;
}): HealLogEntry[];

export function summarizeHealLog(opts: {
  claudeConfigDir: string;
  windowDays?: number;
}): HealLogSummary | null;
