#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * Antigravity CLI (`agy`) PostToolUse hook — session event capture.
 *
 * agy fires hooks from a config at ~/.gemini/config/hooks.json (or via an
 * installed agy plugin's hooks/hooks.json) and pipes a payload whose shape
 * differs from the Claude-Code/Codex wire format this pipeline expects:
 *
 *   { conversationId, stepIdx, toolCall: { name, args }, error,
 *     workspacePaths: [..], transcriptPath, artifactDirectoryPath }
 *
 * The event name arrives as argv (set in hooks.json), NOT in the payload, and
 * the hook CWD is ~/.gemini/config — so the project dir MUST come from
 * workspacePaths[0], never process.cwd(). agy does NOT honor a stdout veto in
 * auto-run mode, so this hook is CAPTURE-ONLY (records the tool event; never
 * blocks). We translate agy's payload into the Claude-shaped `input` the shared
 * extractor/attribution pipeline consumes, then reuse it unchanged.
 */

import {
  readStdin,
  getSessionId,
  getSessionDBPath,
  getInputProjectDir,
  ANTIGRAVITY_CLI_OPTS,
} from "../session-helpers.mjs";
import { createSessionLoaders, attributeAndInsertEvents } from "../session-loaders.mjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB, loadExtract, loadProjectAttribution } = createSessionLoaders(HOOK_DIR);
const OPTS = ANTIGRAVITY_CLI_OPTS;

/** Map agy's hook payload onto the Claude-shaped input the pipeline expects. */
function fromAgy(payload) {
  const toolCall = payload?.toolCall ?? {};
  return {
    session_id: payload?.conversationId,
    transcript_path: payload?.transcriptPath,
    cwd:
      Array.isArray(payload?.workspacePaths) && payload.workspacePaths.length > 0
        ? String(payload.workspacePaths[0])
        : undefined,
    tool_name: toolCall.name ?? "",
    tool_input: toolCall.args ?? {},
    // agy's PostToolUse payload carries no tool-output text, only an error
    // string ("" on success). Capture the call + error state; byte-accounting
    // for output is not available on this surface.
    tool_response: typeof payload?.error === "string" ? payload.error : "",
    tool_output: { isError: typeof payload?.error === "string" && payload.error.length > 0 },
  };
}

try {
  const raw = await readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = {};
  }
  const input = fromAgy(payload);

  if (input.tool_name) {
    const projectDir = getInputProjectDir(input, OPTS);

    const { extractEvents } = await loadExtract();
    const { resolveProjectAttributions } = await loadProjectAttribution();
    const { SessionDB } = await loadSessionDB();

    const dbPath = getSessionDBPath(OPTS, projectDir);
    const db = new SessionDB({ dbPath });
    const sessionId = getSessionId(input, OPTS);

    db.ensureSession(sessionId, projectDir);

    const normalizedInput = {
      tool_name: input.tool_name,
      tool_input: input.tool_input ?? {},
      tool_response: input.tool_response ?? "",
      tool_output: input.tool_output,
    };

    const events = extractEvents(normalizedInput);
    attributeAndInsertEvents(db, sessionId, events, input, projectDir, "PostToolUse", resolveProjectAttributions);
    db.close();
  }
} catch {
  // Swallow errors — a hook must never fail the host agent.
}

// agy ignores hook stdout in auto-run mode; emit nothing (capture-only).
