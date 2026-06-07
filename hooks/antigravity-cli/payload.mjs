/**
 * Shared Antigravity CLI (`agy`) hook payload normalization.
 *
 * agy sends hook payloads as:
 *   { conversationId, stepIdx, toolCall: { name, args }, error,
 *     workspacePaths: [..], transcriptPath, artifactDirectoryPath }
 *
 * The shared context-mode capture/routing code expects Claude-shaped fields, so
 * keep this mapping in one place for PreToolUse/PostToolUse/Stop.
 */

export function parseAgyPayload(raw) {
  try {
    const cleaned = String(raw ?? "").replace(/^\uFEFF/, "").trim();
    return cleaned ? JSON.parse(cleaned) : {};
  } catch {
    return {};
  }
}

export function getAgyProjectDir(payload) {
  return Array.isArray(payload?.workspacePaths) && payload.workspacePaths.length > 0
    ? String(payload.workspacePaths[0])
    : undefined;
}

function normalizeAgyToolName(name) {
  switch (name) {
    case "run_command":
      return "Bash";
    case "view_file":
      return "Read";
    case "grep_search":
      return "Grep";
    case "list_dir":
      return "LS";
    case "web_fetch":
    case "read_url_content":
      return "WebFetch";
    case "search_web":
      return "WebSearch";
    default:
      return name;
  }
}

function normalizeAgyToolInput(toolName, args) {
  const input = args && typeof args === "object" ? { ...args } : {};
  const canonical = normalizeAgyToolName(toolName);
  if (canonical === "Bash" && typeof input.CommandLine === "string" && typeof input.command !== "string") {
    input.command = input.CommandLine;
  }
  if (canonical === "WebFetch") {
    const url = input.url ?? input.URL ?? input.Url;
    if (typeof url === "string" && typeof input.url !== "string") input.url = url;
  }
  if (canonical === "Read") {
    const filePath = input.file_path ?? input.path ?? input.AbsolutePath ?? input.FilePath;
    if (typeof filePath === "string" && typeof input.file_path !== "string") input.file_path = filePath;
  }
  if (canonical === "Grep") {
    const pattern = input.pattern ?? input.Pattern ?? input.query ?? input.Query;
    if (typeof pattern === "string" && typeof input.pattern !== "string") input.pattern = pattern;
  }
  return input;
}

export function fromAgy(payload) {
  const toolCall = payload?.toolCall ?? {};
  const rawToolName = toolCall?.name ?? "";
  return {
    session_id: payload?.conversationId,
    transcript_path: payload?.transcriptPath,
    cwd: getAgyProjectDir(payload),
    tool_name: normalizeAgyToolName(rawToolName),
    tool_input: normalizeAgyToolInput(rawToolName, toolCall?.args),
    tool_response: typeof payload?.error === "string" ? payload.error : "",
    tool_output: {
      isError: typeof payload?.error === "string" && payload.error.length > 0,
    },
  };
}
