# Setup Improvement Checklist

Working notes for smoothing out context-mode's install / setup story across
all 15 supported agent CLIs.

> Scope: this file lives in the **ken-jo fork** to track work-in-progress
> improvements before opening upstream PRs. Each item is sized so it can
> graduate into its own PR against `mksglu/context-mode`.

## Table of Contents

- [Why](#why)
- [Adapter Inventory](#adapter-inventory-15-platforms)
- [Detection Cascade](#detection-cascade)
- [Improvement Checklist](#improvement-checklist)
  - [A. Install UX (highest impact)](#a-install-ux-highest-impact)
  - [B. Self-heal consolidation](#b-self-heal-consolidation)
  - [C. Linux Node<22.5 hard-fail UX](#c-linux-node225-hard-fail-ux)
  - [D. Adapter registry as data](#d-adapter-registry-as-data)
  - [E. MCP-only routing best-effort honesty](#e-mcp-only-routing-best-effort-honesty)
  - [F. Lockfile + publish hygiene](#f-lockfile--publish-hygiene)
- [Suggested PR sequence](#suggested-pr-sequence)
- [Open questions](#open-questions)

## Why

Today every non-Claude-Code platform requires 1–4 manual JSON edits across
2–3 files (`mcp.json`, `hooks.json`, rules file). The README repeats nearly
identical instructions 14 times, and drift between `configs/<platform>/`
templates and the README boilerplate is already visible. The goal is:

> `npm install -g context-mode && context-mode setup` — done. Auto-detect
> the host, write the canonical config, never clobber the user's keys.

Reference inspirations:
- **oh-my-codex (OMX)** — single `omx setup` flow, declarative templates
- **oh-my-claudecode (OMC)** — adapter-driven setup with `omc-setup` skill

## Adapter Inventory (15 platforms)

| # | Adapter           | Detect signal                                   | MCP config target                              | Hook surface                                                                  | Routing |
|---|-------------------|--------------------------------------------------|-------------------------------------------------|--------------------------------------------------------------------------------|---------|
| 1 | claude-code       | `CLAUDE_CODE_ENTRYPOINT`, `~/.claude/`           | `installed_plugins.json` + `settings.json`      | PreToolUse · PostToolUse · PreCompact · SessionStart · UserPromptSubmit         | auto    |
| 2 | gemini-cli        | `GEMINI_PROJECT_DIR`, `~/.gemini/`               | `~/.gemini/settings.json`                       | BeforeTool · AfterTool · PreCompress · SessionStart                            | semi    |
| 3 | vscode-copilot    | `VSCODE_PID`, `~/.vscode/`                       | `.vscode/mcp.json` per-project                  | PreToolUse · PostToolUse · SessionStart · PreCompact                            | semi    |
| 4 | jetbrains-copilot | `IDEA_INITIAL_DIRECTORY`, `~/.config/JetBrains/` | IDE Settings UI (CLI cannot inspect)            | PreToolUse · PostToolUse · SessionStart · PreCompact                            | manual  |
| 5 | cursor            | `CURSOR_TRACE_ID`, `~/.cursor/`                  | `.cursor/mcp.json`                              | preToolUse · postToolUse · stop · afterAgentResponse (no SessionStart)         | semi    |
| 6 | opencode          | `OPENCODE`, `~/.config/opencode/`                | in-process plugin via npm cache                 | tool.execute.before/after · session.compacting · chat.system.transform         | auto    |
| 7 | kilo (kilocode)   | `KILO`, `KILO_PID`                               | same as opencode                                | same as opencode                                                                | auto    |
| 8 | openclaw          | `~/.openclaw/`                                   | gateway native plugin                            | 8 lifecycle hooks via `api.on()`                                               | auto    |
| 9 | codex             | `CODEX_THREAD_ID`, `~/.codex/`                   | `config.toml` `[mcp_servers.context-mode]`      | PreTool · PostTool · SessionStart · UserPromptSubmit · Stop · PreCompact        | trust   |
| 10 | qwen-code        | `QWEN_PROJECT_DIR`, MCP clientInfo               | `~/.qwen/settings.json`                         | Claude-Code-compatible wire                                                     | semi    |
| 11 | antigravity      | `ANTIGRAVITY_CLI_ALIAS`                          | MCP-only                                         | none (`GEMINI.md` only)                                                         | manual  |
| 12 | kiro             | `~/.kiro/`, MCP clientInfo                       | UI Settings MCP                                  | preToolUse · postToolUse · agentSpawn · userPromptSubmit                        | semi    |
| 13 | zed              | `ZED_SESSION_ID`, `~/.config/zed/`               | settings.json MCP                                | none (`AGENTS.md` only)                                                         | manual  |
| 14 | pi               | `PI_CONFIG_DIR`, `~/.pi/`                        | Pi extension (`.pi/extensions/context-mode/`)   | tool_call · tool_result · session_start · session_before_compact               | auto    |
| 15 | omp              | `PI_CODING_AGENT_DIR`, `~/.omp/`                 | OMP plugin                                       | tool_call · tool_result · session_start · session_before_compact               | auto    |

## Detection Cascade

`src/adapters/detect.ts` resolves the active host with this priority:

1. **MCP `clientInfo.name`** — authoritative when the handshake names a known client (`CLIENT_NAME_TO_PLATFORM`, plus the `qwen-cli-mcp-client-*` pattern)
2. **`CONTEXT_MODE_PLATFORM`** env override
3. **High-confidence env vars** — registry in `_PLATFORM_ENV_VARS_RAW`, forks listed before parents (cursor/antigravity before vscode-copilot)
4. **Medium-confidence config dirs** — CLI agents (`~/.kiro`, `~/.omp`, `~/.pi`, `~/.qwen`, `~/.openclaw`) before host IDEs (issue #542)
5. **Fallback** — `claude-code` with `low` confidence

Disambiguator carve-outs already in place:
- **#539:** VSCODE_PID set + `~/.claude/plugins/installed_plugins.json` lists context-mode → resolve to claude-code (memoized read)
- **#542:** Cursor co-installed with CLI agents → CLI agents win the medium tier
- **#545:** `workspaceEnvVarsFor` / `foreignWorkspaceEnv` split so Pi's MCP bridge can scrub foreign workspace env vars
- **#561:** `foreignIdentificationEnv` mirror so spawned MCP children do not misidentify the host

## Improvement Checklist

### A. Install UX (highest impact)

- [x] **A3.** README "Quick install" capsule at the top of the Install
  section promises one-line setup across every supported agent CLI:
  `npm install -g context-mode && context-mode setup`. Per-platform
  sections preserved unchanged (the maintainer's careful escape-hatch
  JSON snippets remain for users who prefer manual config or are on a
  host where the marketplace handles install). MCP-only banner added
  to Antigravity + Zed sections so users see the same "Routing fidelity:
  best-effort (~60%)" honesty `doctor` already emits.
- [x] **A1.** Add `context-mode setup [<platform>]` subcommand
  - `src/cli.ts` — registered routing alongside `doctor`, `upgrade`, `hook`, `insight`, `statusline`
  - `src/setup.ts` — new module
    - `detectPlatform()` → resolve adapter
    - read existing target config (mcp.json / hooks.json / settings.json) if any
    - shallow-merge into the server map only (preserves user keys)
    - **atomic write** via tmpfile + rename
    - flags: `--check` (dry-run, exit 1 on drift), `--platform <id>`, `--force`, `--scope user|project`
  - Behavior matrix per platform: json-stdio (7) writes; managed-externally (claude-code, opencode, kilo, openclaw, pi, omp) prints pointer; TOML/UI (codex, jetbrains-copilot) prints manual snippet
  - Hook idempotency: `--check` reports "WOULD CONFIGURE" because `adapter.configureAllHooks` lacks a true-diff mode — fix tracked as B-side improvement
- [ ] **A2.** Wire `npm run setup` script to the new subcommand (today it is dead — only `npx tsx src/cli.ts setup` works because `cli.ts` has no `setup` handler)
- [ ] **A3.** Make `configs/<platform>/` the single source of truth
  - one canonical `mcp.json` + `hooks.json` (+ optional rules) per platform
  - README sections collapse to: prerequisites · `npm install -g context-mode && context-mode setup` · verify
  - drop the repeated 30-line JSON blocks from README (link to `configs/<platform>/` instead)
- [ ] **A4.** Add `context-mode setup --uninstall` to remove only our own keys (use a JSON path manifest in `configs/<platform>/setup.manifest.json`)
- [ ] **A5.** `context-mode doctor` learns to emit a one-line `context-mode setup` suggestion when registration is missing (currently only logs `WARN` / `ERROR`)
- [ ] **A6.** Tests: `tests/setup/*.test.ts` covers idempotent merge, user-key preservation, `--check` exit codes, every adapter in the matrix

### B. Self-heal consolidation

- [x] **B0.** Structural source-grep tests rewritten to follow the new SOT
  — both `tests/util/start-mjs-self-heal.test.ts` and
  `tests/util/postinstall-heal-mcp-json.test.ts` now assert
  (a) the surface script wires `runRuntimeHealSuite`, (b) the suite itself
  imports and calls all 4 healers. Contract preserved at two levels with
  17 cases unchanged in count.
- [x] **B1.** `scripts/lib/heal/runtime-heal-suite.mjs` exports
  `runRuntimeHealSuite({ pluginKey, claudeConfigDir, phase })` returning
  `{ healed, skipped, errors, swept, notes }`. Never throws; each layer
  has its own try/catch so a Layer 5b failure cannot skip Layer 5c.
- [x] **B2.** `scripts/postinstall.mjs` (was ~100 lines of inline heal
  loops) and `start.mjs` (was ~60 lines) each reduce to one
  `runRuntimeHealSuite()` call.
- [x] **B3.** Each healer already had its own unit test in
  `tests/util/heal-installed-plugins.test.ts` — confirmed still passing
  after the consolidation. Suite-level behavior is exercised indirectly
  by `tests/util/postinstall-heal.test.ts` (spawn-based integration).
- [ ] **B4.** Per-phase manifest for doctor (`heal.log` in `${CLAUDE_CONFIG_DIR}/context-mode/`) — deferred to a follow-up PR; the structure to record it is already there (`runRuntimeHealSuite` returns a structured report), but the read-back surface in doctor isn't needed for the consolidation itself.

### C. Linux Node<22.5 hard-fail UX

- [ ] **C1.** Move the SIGSEGV/madvise guard from `postinstall` to a `preinstall` script — fails before downloading deps (~30 MB / ~10s saved on broken installs)
- [ ] **C2.** Add `"engineStrict": true` to `.npmrc` (project-local) so npm enforces `engines.node >= 22.5` itself
- [ ] **C3.** Update remediation text to detect package manager (`npm` vs `pnpm` vs `bun`) and give the right install hint

### D. Adapter registry as data

- [x] **D1.** Move the three adapter sources of truth into one file
  - was: `_PLATFORM_ENV_VARS_RAW` + `getSessionDirSegments` + `getAdapter` switch all needed to stay in sync per adapter
  - now: `src/adapters/registry.ts` with `{ id, sessionDirSegments, load }` per platform; `detect.ts` derives both lookups from it (`getSessionDirSegments` and `getAdapter` are 1-line wrappers)
- [x] **D2.** `PLATFORM_ENV_VARS` is now derived from `ADAPTER_REGISTRY` (filtered to entries with non-empty `envVars`). `EnvVarRole` + `PlatformEnvEntry` types moved to `src/adapters/types.ts` to avoid the detect → registry → detect cycle; detect.ts re-exports them for back-compat with `src/util/project-dir.ts` and the hook layer. Registry order is now the env-detection precedence — fork-before-parent invariants for antigravity/cursor before vscode-copilot, kilo before opencode, and omp before pi are locked in by 3 new ordering assertions in `tests/adapters/registry.test.ts`. Build-time codegen ruled out as overkill; the data file is itself canonical.
- [x] **D3.** Add a registry matrix test that fails if a new adapter directory exists without a registry entry — `tests/adapters/registry.test.ts` (7 cases)

### E. MCP-only routing best-effort honesty

- [x] **E1.** Audit Antigravity + Zed for any newly added pre-message hook surface — neither adapter exposes a hook surface; both explicitly throw `"does not support hooks"` from `parsePreToolUseInput` etc. Confirmed via `paradigm === "mcp-only"`.
- [x] **E2.** Doctor + setup both emit `Routing fidelity: best-effort (~60%)` immediately after the Platform line when `adapter.paradigm === "mcp-only"`. Guard: `tests/cli/mcp-only-routing-honesty.test.ts`. README banner deferred to the A3 README slim-down PR.

### F. Lockfile + publish hygiene

- [x] **F1.** ~~Commit `package-lock.json`~~ — **closed as by-design.** Maintainer ships `bun.lock` as the source of truth and explicitly `.gitignore`s `package-lock.json`. npm users get whatever npm resolves; that trade-off is documented in README's Build Prerequisites. Locked in by `tests/util/lockfile-policy.test.ts` so the policy can't drift accidentally.
- [x] **F2.** `tests/util/publish-tarball.test.ts` runs `npm pack --dry-run` and locks in the publish manifest: 17 required files MUST ship (boot path + scripts/lib/runtime-precheck.mjs + the new preinstall), 10 forbidden paths MUST NOT (src/, tests/, bun.lock, vitest config, BENCHMARK/CONTRIBUTING/CLAUDE markdowns). Size and entry-count budgets (5MB / 300 files) catch accidental glob-widening regressions. Today: 598KB / 158 files.
- [x] **F3.** *(no action needed — measured.)* Happy-path postinstall is already <1s: `healInstalledPlugins` no-ops when registry is missing (early `return { skipped: "no-registry" }`), `healPluginJsonMcpServers` only walks present cache entries, and `healBetterSqlite3Binding` early-exits when the binding is already loadable. The only slow path is when the better-sqlite3 binding is genuinely broken — at that point the user wants the rebuild, deferring would break the next MCP boot. Conclusion: defer-to-first-boot is not the right knob; the heal helpers' own early-exits already provide it.

## Suggested PR sequence

User-perceived impact is the ordering signal. Each PR is independent.

1. **PR-1 — Install UX foundation** (A1 + A2 + A3 + A6)
   – Ship `setup` subcommand and slim down README.
2. **PR-2 — Doctor & uninstall** (A4 + A5)
   – Round-trip the setup story.
3. **PR-3 — Adapter registry** (D1 + D2 + D3)
   – Refactor under tests; safe-deletes ~120 lines of switch boilerplate.
4. **PR-4 — Heal consolidation** (B1 + B2 + B3 + B4)
   – Reduces postinstall.mjs from 375 lines to ~50.
5. **PR-5 — Linux guard relocation** (C1 + C2 + C3)
   – Smallest behavior surface, ship anytime.
6. **PR-6 — Lockfile + publish** (F1 + F2 + F3) and **MCP-only honesty** (E1 + E2)
   – Hygiene bundle.

## Discovered issues (live log)

Captured during the work pass so they don't get lost. Promote to numbered
checklist items when scoped, or close out inline if trivial.

- [ ] **Hook idempotency.** `adapter.configureAllHooks` always reports
  "Updated existing … hook entry" even when the entry already matches the
  desired value. `setup --check` therefore reports `WOULD CONFIGURE` even
  when nothing would actually change. Fix in adapter base: skip the
  rewrite when the entry's `command` + `matcher` already equal the target.
- [ ] **`prebuild-install@7.1.3` deprecation warning** during `npm install`
  (transitive via `better-sqlite3`). Upstream is unmaintained. Track for a
  drop-in replacement (`prebuildify` consumers / `binding-version`).
- [ ] **Pre-existing TypeScript diagnostics in `src/cli.ts`** that surface
  on every tsc run (unused `writeFileSync`/`mkdirSync` imports, missing
  `.d.mts` for `../scripts/heal-installed-plugins.mjs` and
  `../scripts/heal-better-sqlite3.mjs`). Not introduced by these PRs but
  worth a separate cleanup.
- [ ] **Stale `cli.bundle.mjs`** ships with every source change until
  `npm run build` re-bundles. Today the publishing flow handles this
  (`prepublishOnly: npm run build`) but contributors hit stale bundle
  surprises locally. Consider a `pre-commit` hook or a CI assertion that
  the committed bundle matches `npm run build` output.
- [ ] **`/tmp/.git` pollution breaks `isGlobalInstall()` heuristic.** On
  Devbox/Codespaces images where `/tmp` is a git repo (some Docker
  bootstrap scripts do this), `isGlobalInstall()` walks up from a
  tmpdir-staged package and finds `/tmp/.git` → returns `false` → heal
  block silently skipped. Affects 3 tests in `postinstall-heal.test.ts`
  on these machines. Fix: bound the walk by walking AT MOST 2 levels OR
  detect-and-ignore `/tmp/.git`. Maintainer call: tightening the
  heuristic vs. accepting that contributor envs are unusual.
- [ ] **`setup --check` for hooks lacks true diff.** Today returns drift
  unconditionally for json-stdio platforms when hooks are needed. Same
  root cause as the hook idempotency item above — once adapters compare
  before rewriting, `--check` can be honest.

## Open questions

- [ ] `setup` should it accept `--scope user|project|local` like `claude mcp add`?
- [ ] Where does the merge manifest live for adapters whose config has nested arrays (cursor hooks `[{matcher, hooks: [...]}]`)? Need JSON-path or shallow-array dedupe semantics — propose `setup.manifest.json` per adapter that names "owned" keys.
- [ ] OpenClaw / Pi extensions install into `.openclaw/` / `.pi/` — `setup` here is mostly a no-op (their native plugin systems handle MCP registration). Document as "managed externally" rather than running a write.
- [ ] OpenCode / Kilo install via npm into a per-package cache (`~/.cache/opencode/packages/...`). Setup may not need to write anything here either — confirm.
