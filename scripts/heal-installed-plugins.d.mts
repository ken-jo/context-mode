/**
 * Type declarations for the JS heal helpers shared between
 * scripts/postinstall.mjs and src/ TypeScript callers.
 *
 * The runtime source lives in scripts/heal-installed-plugins.mjs as a
 * plain `.mjs` module (no TS toolchain dependency for postinstall). This
 * `.d.mts` lets src/cli.ts + src/setup.ts import the symbols with full
 * inference instead of `@ts-expect-error` suppressions.
 */

export interface HealResult {
  healed: string[];
  skipped?: string;
  error?: string;
}

export interface SweepResult {
  removed: string[];
  skipped?: string;
}

export function healInstalledPlugins(opts: {
  registryPath: string;
  pluginCacheRoot: string;
  pluginKey: string;
}): HealResult;

export function healSettingsEnabledPlugins(opts: {
  settingsPath: string;
  pluginKey: string;
}): HealResult;

export function healPluginJsonMcpServers(opts: {
  pluginRoot: string;
  pluginCacheRoot: string;
  pluginKey: string;
}): HealResult;

export function healMcpJsonArgs(opts: {
  pluginRoot: string;
  pluginCacheRoot: string;
  pluginKey: string;
}): HealResult;

export function healClaudeJsonMcpArgs(opts: {
  dotClaudeJsonPath: string;
  pluginCacheParent: string;
  newPluginRoot: string;
}): HealResult;

export function sweepStaleMcpJson(opts: {
  pluginCacheRoot: string;
  pluginKey: string;
}): SweepResult;
