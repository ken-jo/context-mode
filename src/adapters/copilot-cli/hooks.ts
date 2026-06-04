/**
 * adapters/copilot-cli/hooks — GitHub Copilot CLI hook definitions.
 *
 * Copilot CLI accepts both camelCase hook event names and VS Code-compatible
 * PascalCase event names. We emit PascalCase so the host sends snake_case
 * payload fields, matching the existing Copilot hook wrappers.
 */

export const HOOK_TYPES = {
  PRE_TOOL_USE: "PreToolUse",
  POST_TOOL_USE: "PostToolUse",
  PRE_COMPACT: "PreCompact",
  SESSION_START: "SessionStart",
} as const;

export type HookType = (typeof HOOK_TYPES)[keyof typeof HOOK_TYPES];

export const HOOK_SCRIPTS: Record<string, string> = {
  [HOOK_TYPES.PRE_TOOL_USE]: "pretooluse.mjs",
  [HOOK_TYPES.POST_TOOL_USE]: "posttooluse.mjs",
  [HOOK_TYPES.PRE_COMPACT]: "precompact.mjs",
  [HOOK_TYPES.SESSION_START]: "sessionstart.mjs",
};

export const REQUIRED_HOOKS: HookType[] = [
  HOOK_TYPES.PRE_TOOL_USE,
  HOOK_TYPES.SESSION_START,
];

export const OPTIONAL_HOOKS: HookType[] = [
  HOOK_TYPES.POST_TOOL_USE,
  HOOK_TYPES.PRE_COMPACT,
];

export function isContextModeHook(
  entry: { command?: string; hooks?: Array<{ command?: string }> },
  hookType: HookType,
): boolean {
  const scriptName = HOOK_SCRIPTS[hookType];
  if (!scriptName) return false;
  const cliCommand = buildHookCommand(hookType);
  if (entry.command?.includes(cliCommand) || entry.command?.includes(scriptName)) {
    return true;
  }
  return (
    entry.hooks?.some((h) =>
      h.command?.includes(scriptName) || h.command?.includes(cliCommand),
    ) ?? false
  );
}

export function buildHookCommand(hookType: HookType, _pluginRoot?: string): string {
  const scriptName = HOOK_SCRIPTS[hookType];
  if (!scriptName) {
    throw new Error(`No script defined for hook type: ${hookType}`);
  }
  return `context-mode hook copilot-cli ${hookType.toLowerCase()}`;
}
