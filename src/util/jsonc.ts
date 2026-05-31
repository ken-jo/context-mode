/**
 * util/jsonc — string-aware JSONC comment + trailing-comma stripping and a
 * tolerant parse. Several agent CLIs ship config files as JSONC (VS Code
 * `mcp.json`, Zed `settings.json`), so a strict `JSON.parse` false-fails on a
 * perfectly valid commented file. Use `parseJsonc` whenever reading a
 * platform config we did not write ourselves.
 *
 * (Consolidates the copies previously inlined in src/server.ts and
 * src/setup.ts. server.ts keeps its own copy only because it ships in a
 * separate bundle that must not pull this module's import graph.)
 */

/** Strip `//` line + `/* *​/` block comments and trailing commas, string-aware. */
export function stripJsonComments(str: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  let inBlockComment = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    const next = str[i + 1];
    if (inBlockComment) {
      if (c === "*" && next === "/") { inBlockComment = false; i++; }
      continue;
    }
    if (escaped) { out += c; escaped = false; continue; }
    if (c === "\\") { out += c; escaped = inString; continue; }
    if (c === '"') { inString = !inString; out += c; continue; }
    if (!inString && c === "/" && next === "/") {
      while (i < str.length && str[i] !== "\n") i++;
      if (i < str.length) out += "\n";
      continue;
    }
    if (!inString && c === "/" && next === "*") { inBlockComment = true; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Parse JSON or JSONC. Tries strict `JSON.parse` first (fast, exact), then a
 * comment/trailing-comma-stripped parse. Returns `undefined` when both fail.
 */
export function parseJsonc<T = unknown>(raw: string): T | undefined {
  for (const candidate of [raw, stripJsonComments(raw)]) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      /* try next */
    }
  }
  return undefined;
}
