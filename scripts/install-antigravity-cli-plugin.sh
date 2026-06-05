#!/usr/bin/env bash
# One-shot installer: register the context-mode plugin into Antigravity CLI (agy).
#
# Mirrors scripts/install-openclaw-plugin.sh — the user runs `npm run install:agy`
# and this script auto-resolves the bundle path, so no `$(npm root -g)/...` typing
# is needed. The bundle (configs/antigravity-cli/) registers the context-mode MCP
# server, the routing skill, and a PostToolUse capture hook in one step.
#
# Usage: ./scripts/install-antigravity-cli-plugin.sh

set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="$PLUGIN_ROOT/configs/antigravity-cli"

# — preflight —
if ! command -v agy &>/dev/null; then
  echo "✗ 'agy' (Antigravity CLI) not found in PATH. Install agy first, then re-run." >&2
  exit 1
fi
if [ ! -d "$BUNDLE" ]; then
  echo "✗ plugin bundle not found at $BUNDLE" >&2
  exit 1
fi

echo "→ context-mode agy plugin installer"
echo "  bundle : $BUNDLE"

# The plugin's MCP server runs the global `context-mode` binary (it needs the
# native better-sqlite3 dependency, which a bare clone does not have). Warn — do
# not silently global-install on the user's behalf.
if ! command -v context-mode &>/dev/null; then
  echo "⚠ 'context-mode' is not on PATH — the plugin's MCP server requires it." >&2
  echo "  Install it with:  npm install -g context-mode" >&2
fi

agy plugin install "$BUNDLE"

# Probe whether the global `context-mode` understands the antigravity-cli hook.
# The shipped hook command (`context-mode hook antigravity-cli posttooluse`)
# resolves the GLOBAL binary at runtime. A context-mode older than the release
# that added Antigravity CLI support has no `antigravity-cli` HOOK_MAP entry and
# exits 1 — and the dispatcher suppresses stderr, so the capture hook would be a
# SILENT no-op. Detect that here and tell the user instead of claiming it works.
CAPTURE_OK=0
if command -v context-mode &>/dev/null \
  && printf '{}' | context-mode hook antigravity-cli posttooluse &>/dev/null; then
  CAPTURE_OK=1
fi

echo
echo "✓ Installed the context-mode agy plugin: MCP server + routing skill."
if [ "$CAPTURE_OK" = "1" ]; then
  echo "✓ PostToolUse capture hook is ACTIVE (this context-mode supports antigravity-cli)."
else
  echo "⚠ PostToolUse capture hook is INACTIVE: your global 'context-mode' is missing or too old" >&2
  echo "  to handle 'context-mode hook antigravity-cli'. MCP tools + the routing skill still work." >&2
  echo "  Enable capture with:  npm install -g context-mode@latest" >&2
fi
echo
echo "  Restart agy, then verify:"
echo "    agy -p \"Use the context-mode ctx_execute MCP tool to compute 7 + 5. Answer only the number.\" --dangerously-skip-permissions"
echo "  Expected output: 12"
