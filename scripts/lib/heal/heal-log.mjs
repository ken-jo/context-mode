/**
 * scripts/lib/heal/heal-log — JSON-Lines append-only ledger for
 * `runRuntimeHealSuite` invocations.
 *
 * Item B4 of docs/setup-improvements.md. Each heal pass appends one line
 * with `{ ts, phase, healed[], skipped[], errors[], sweptCount }`.
 * `doctor` reads the last 7 days and prints a one-block summary so users
 * can see how often the heal block actually has to do work — a high
 * "healed/total" ratio signals an upstream regression (e.g. Claude Code
 * auto-update repeatedly poisoning the registry).
 *
 * Capped at 500 lines (~7 days for typical users with daily MCP boots).
 * Append-only (no mid-file mutation): simpler atomicity, never corrupts
 * the file under concurrent writes from postinstall + start.mjs.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Hard cap so the ledger doesn't grow unbounded. */
const MAX_LINES = 500;

/**
 * @typedef {Object} HealLogEntry
 * @property {string} ts                ISO timestamp (UTC).
 * @property {"postinstall" | "mcp-boot"} phase
 * @property {string[]} healed
 * @property {string[]} skipped
 * @property {string[]} errors
 * @property {number} sweptCount
 */

/** Resolve `${claudeConfigDir}/context-mode/heal.log`. */
function healLogPath(claudeConfigDir) {
  return resolve(claudeConfigDir, "context-mode", "heal.log");
}

/**
 * Append one heal-suite report as a JSON line. Best-effort: never throws,
 * never blocks the caller. Creates the parent dir on first write.
 *
 * @param {{
 *   claudeConfigDir: string,
 *   entry: Omit<HealLogEntry, "ts"> & { ts?: string },
 * }} opts
 */
export function appendHealLog({ claudeConfigDir, entry }) {
  if (!claudeConfigDir || !entry) return;
  const ts = entry.ts ?? new Date().toISOString();
  const line = JSON.stringify({ ...entry, ts }) + "\n";
  const path = healLogPath(claudeConfigDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line, "utf-8");
    // Rotate when the file outgrows MAX_LINES — read, tail-slice, rewrite.
    // Cheaper than a per-write line count: only check on lines that end in
    // `\n` which they all do, and only rewrite when we exceed the cap.
    const text = readFileSync(path, "utf-8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    if (lines.length > MAX_LINES) {
      const trimmed = lines.slice(-MAX_LINES).join("\n") + "\n";
      writeFileSync(path, trimmed, "utf-8");
    }
  } catch { /* best effort */ }
}

/**
 * Read all heal-log entries (newest last). Returns [] when the log
 * doesn't exist or any line fails to parse — the caller decides whether
 * to surface that.
 *
 * @param {{ claudeConfigDir: string, sinceMs?: number }} opts
 * @returns {HealLogEntry[]}
 */
export function readHealLog({ claudeConfigDir, sinceMs }) {
  const path = healLogPath(claudeConfigDir);
  if (!existsSync(path)) return [];
  let raw;
  try { raw = readFileSync(path, "utf-8"); }
  catch { return []; }
  /** @type {HealLogEntry[]} */
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (sinceMs !== undefined) {
        const t = Date.parse(parsed.ts);
        if (Number.isFinite(t) && t < sinceMs) continue;
      }
      out.push(parsed);
    } catch { /* skip malformed line */ }
  }
  return out;
}

/**
 * Summarize the last `windowDays` of entries for the doctor display.
 * Returns null when the log is empty.
 *
 * @param {{ claudeConfigDir: string, windowDays?: number }} opts
 * @returns {{
 *   total: number,
 *   healed: number,
 *   skippedOnly: number,
 *   errors: number,
 *   swept: number,
 *   lastPhases: Record<string, number>,
 * } | null}
 */
export function summarizeHealLog({ claudeConfigDir, windowDays = 7 }) {
  const since = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const entries = readHealLog({ claudeConfigDir, sinceMs: since });
  if (entries.length === 0) return null;
  let healed = 0;
  let skippedOnly = 0;
  let errors = 0;
  let swept = 0;
  /** @type {Record<string, number>} */
  const lastPhases = {};
  for (const e of entries) {
    if (Array.isArray(e.healed) && e.healed.length > 0) healed += 1;
    else if (Array.isArray(e.errors) && e.errors.length > 0) errors += 1;
    else skippedOnly += 1;
    if (typeof e.sweptCount === "number") swept += e.sweptCount;
    const phase = typeof e.phase === "string" ? e.phase : "unknown";
    lastPhases[phase] = (lastPhases[phase] ?? 0) + 1;
  }
  return {
    total: entries.length,
    healed,
    skippedOnly,
    errors,
    swept,
    lastPhases,
  };
}
