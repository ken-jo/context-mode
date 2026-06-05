#!/usr/bin/env node
import "../suppress-stderr.mjs";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readStdin } from "../core/stdin.mjs";
import { routePreToolUse, initSecurity } from "../core/routing.mjs";
import { formatDecision } from "../core/formatters.mjs";
import { parseStdin, getSessionId, getInputProjectDir, COPILOT_OPTS } from "../session-helpers.mjs";

const __hookDir = dirname(fileURLToPath(import.meta.url));
await initSecurity(resolve(__hookDir, "..", "..", "build"));

const raw = await readStdin();
const input = parseStdin(raw);
const tool = input.tool_name ?? input.toolName ?? "";
const toolInput = input.tool_input ?? input.toolArgs ?? {};
const projectDir = getInputProjectDir(input, COPILOT_OPTS);

const decision = routePreToolUse(
  tool,
  toolInput,
  projectDir,
  "copilot-cli",
  getSessionId(input, COPILOT_OPTS),
);
const response = formatDecision("copilot-cli", decision);
if (response !== null) {
  process.stdout.write(JSON.stringify(response) + "\n");
}
