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
- [x] **B4.** `scripts/lib/heal/heal-log.mjs` now writes one JSON line per `runRuntimeHealSuite` invocation to `${CLAUDE_CONFIG_DIR}/context-mode/heal.log` (capped at 500 lines, append-only). `context-mode doctor` reads the last 7-day window and prints `Heal history: PASS — N run(s), healed/total mutated state (errors: E, swept: S); phases postinstall: X, mcp-boot: Y` so users can spot upstream regressions that force the heal block to do work every boot. Unit coverage in `tests/util/heal-log.test.ts` (6 cases — append/read/summarize/cap/malformed-line tolerance/per-phase aggregation).

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

- [x] **DI-1 — Hook idempotency.** Fixed in claude-code, gemini-cli, cursor,
  qwen-code (codex was already idempotent). Each adapter's
  `configureAllHooks` now `JSON.stringify`-compares an existing entry to
  desired before reporting "Updated existing…" — and skips the
  `writeSettings()` call entirely when no real changes accumulated.
  Verified: re-running `context-mode setup` against an already-configured
  HOME now reports "Hooks: up-to-date" + "Already configured — nothing
  to do." instead of churning the settings file.
- [ ] **DI-2 — `prebuild-install@7.1.3` deprecation warning** during
  `npm install` (transitive via `better-sqlite3`). Upstream is
  unmaintained — tracked at
  https://github.com/prebuild/prebuild-install/issues/162 and
  https://github.com/WiseLibs/better-sqlite3/issues/1281. Migration to
  `prebuildify`-consuming alternatives is awaiting `better-sqlite3`
  v13.x. No action on our side beyond bumping the dep range when v13
  ships; documented here so the deprecation warning is not interpreted
  as a context-mode regression.
- [x] **DI-3 — Pre-existing TypeScript diagnostics in `src/cli.ts`.**
  Removed unused `writeFileSync` + `mkdirSync` imports. Added
  `scripts/heal-installed-plugins.d.mts` + `scripts/heal-better-sqlite3.d.mts`
  declaration siblings so the `@ts-expect-error` suppressions could come
  out — TypeScript now resolves the .mjs imports with full inference.
  `tsc --noEmit` clean.
- [x] **DI-4 — Stale `cli.bundle.mjs` publish gap.** Added
  `Assert committed bundles match fresh build` step to `.github/workflows/ci.yml`
  (Ubuntu-only to keep parallel matrix cheap). After the existing
  `Build` + `Bundle` steps, the new step runs `git diff --exit-code`
  against `*.bundle.mjs` + `hooks/*.bundle.mjs`. PRs with source edits
  but missing bundle refresh fail with the `npm run bundle` remediation.
- [x] **DI-5 — `/tmp/.git` pollution.** Bounded `isGlobalInstall()` walk
  to depth 0 (just `pkgRoot/.git`). The 4-level walk was paranoia —
  workspace `.git` scenarios are already eliminated by the
  `npm_config_global === "true"` precondition (`npm install` in a
  workspace doesn't set it). 3 previously-failing tests in
  `postinstall-heal.test.ts` now pass.
- [x] **DI-6 — `setup --check` for hooks honesty.** With DI-1 the message
  changed from "WOULD CONFIGURE" to "setup is idempotent — re-run
  `context-mode setup` to refresh (no-op when state is current)". True
  diff would require each adapter to expose a non-destructive
  `wouldConfigureHooks()` — out of scope; the user experience is now
  honest because running setup is the no-op the user expects.

## Workflow verification findings (official-source cross-check)

A 62-agent dynamic workflow cross-checked every platform's `setup.ts`
MCP-registration + `registry.ts` env-var claims against (a) the in-repo
adapter (the file `doctor` reads), (b) `configs/<platform>/` templates,
(c) `docs/platform-support.md`, and (d) each agent CLI's **official GitHub
source / docs** (web). Each discrepancy was adversarially re-verified to
kill doc-misread false positives. 8 issues survived.

### Fixed (bugs in the setup feature authored this session)

- [x] **WV-1 — antigravity path/filename/scope (HIGH).** `setup` wrote
  `<project>/.antigravity/mcp.json` but `AntigravityAdapter.getSettingsPath`
  (= the path `doctor` reads) is `~/.gemini/antigravity/mcp_config.json`
  (home-rooted, filename `mcp_config.json`). Three-axis divergence → setup
  succeeded but doctor reported WARN and Antigravity never loaded the server.
  Fixed `MCP_REGISTRATIONS.antigravity.resolvePath` → home-rooted
  `mcp_config.json`, removed from project-scope default. Matches adapter +
  `configs/antigravity/mcp_config.json` + `antigravity.google/docs/mcp`.
- [x] **WV-2 — kiro project-vs-user split (HIGH).** `setup` wrote project
  `.kiro/settings/mcp.json` (and ignored `--scope`), doctor reads
  `~/.kiro/settings/mcp.json`. Fixed: `resolvePath` now branches on scope
  (like cursor/vscode-copilot), default scope is **user** so it writes the
  file doctor reads; `--scope project` still works. Both paths are valid per
  `kiro.dev/docs/mcp/configuration`.
- [x] **WV-3 — jetbrains-copilot wrong settings node (HIGH).** The manual
  hint said "Settings > Tools > **AI Assistant**" — that is JetBrains' own
  native AI product, not the GitHub Copilot plugin; the GitHub Copilot MCP
  server cannot be registered there. The adapter's own doctor fix and the
  official `github/github-mcp-server` docs say **GitHub Copilot icon > Edit
  Settings > Model Context Protocol > Configure** (mcp.json, top-level
  `servers`). Fixed the hint text.
- [x] **WV-4 — opencode hint filename (MEDIUM).** Hint said add the plugin
  to `~/.config/opencode/config.json`, but the adapter only reads
  `opencode.json`/`opencode.jsonc`. Fixed hint → `opencode.json`.
- [x] **WV-5 — pi false postinstall claim (MEDIUM).** Hint claimed "npm
  postinstall normally handles this" — `postinstall.mjs` has no Pi handling.
  Softened the hint and cross-referenced DI-7.
- [x] **Regression guards:** `tests/setup/setup.test.ts` gains a
  "setup↔doctor path agreement" describe that asserts the adapter's READ
  path equals setup's DEFAULT WRITE path for antigravity, kiro, gemini-cli;
  the matrix tests' `expectedTargetPath` was retargeted to the adapter paths.

### Pre-existing maintainer-code issues (flagged, not blind-edited)

- [ ] **DI-7 — pi global extension dir missing `agent/` segment (HIGH,
  pre-existing).** `PiAdapter` (`src/adapters/pi/index.ts:166-172,199-205`),
  `scripts/version-sync.mjs:31`, and the committed `.pi/extensions/` all use
  `~/.pi/extensions/context-mode/`, but per `earendil-works/pi`
  `docs/extensions.md` the GLOBAL auto-discovery dir is `~/.pi/agent/extensions/`
  (project scope `.pi/extensions/` IS correct). The sibling `OMPAdapter`
  already uses the `agent/` segment, so the convention is known. NOT edited
  here: the `pi` / `oh-my-pi` / `@mariozechner/pi` fork lineage is ambiguous
  in this repo (comments reference can1357/oh-my-pi while the official dir
  comes from earendil-works/pi) — the maintainer should confirm the target
  fork before changing the adapter + version-sync + committed dir together.
- [ ] **DI-8 — contested / phantom env-var detection signals (MEDIUM,
  pre-existing).** The workflow flagged `OPENCODE_PROJECT_DIR` (opencode),
  `ZED_SESSION_ID` (zed), and `PI_CONFIG_DIR`/`PI_SESSION_FILE`/`PI_COMPILED`
  (pi) as not provably emitted by those runtimes (zero source hits / refs/
  evidence dir absent). These pre-date this session's work (D2 only *moved*
  them) and the maintainer's comments treat some as load-bearing for the
  `resolveProjectDir` cascade — blind deletion risks a detection regression.
  Recommend the maintainer re-source each against current upstream and demote
  to `detect:false` or remove. Benign at runtime today (`|| process.cwd()`
  fallbacks).
- [x] **DI-9 — doc accuracy nits (LOW, docs-only).** Fixed in
  `docs/platform-support.md` after verifying each claim against the actual
  adapter code (the authoritative runtime):
  - antigravity "No verified env vars" → corrected to document
    `ANTIGRAVITY_CLI_ALIAS` (registry.ts) + the gemini-cli detect-ide.ts source.
  - OMP section + the two summary-table cells: `OMP_PROCESSING_AGENT_DIR` →
    `PI_CODING_AGENT_DIR` (matches `OMPAdapter.getAgentDir`),
    `mcp_config.json` → `mcp.json` (matches `getSettingsPath`),
    `PI.md` → `SYSTEM.md` / `AGENTS.md` (matches `getInstructionFiles`).
  - kiro `clientInfo.name="Kiro CLI"` line annotated best-effort (the cited
    #5205 is an LSP null-clientInfo bug; detection falls back to the
    `~/.kiro/` config-dir tier, which is by-design env-var-less).
  Runtime unchanged — these were doc lag against already-correct code.

### Platforms verified CLEAN (first pass — see correction below)

cursor, kilo, openclaw, omp (runtime correct; only stale docs). All received
both internal-consistency AND official-web verification (`webAvailable: true`
for all 14).

> **Correction (second pass):** the first pass wrongly marked **gemini-cli**,
> **vscode-copilot**, **codex**, and **qwen-code** as fully CLEAN. A second
> 11-agent re-verification workflow (focused on the fixes + a completeness
> critic for missed issues) found real bugs in all four — see below. The
> first-pass path-only regression guard gave false confidence because it
> never asserted the doctor read the same container KEY setup wrote.

## Second-pass verification findings (re-verify + completeness)

An 11-agent workflow (1) adversarially re-confirmed WV-1~5 still hold and
introduced no new mismatch, (2) audited the global `defaultScopeFor` refactor
+ the DI-1 idempotency change for regressions, and (3) ran completeness
critics for issues the first pass missed. Result: WV-1~5 all still correct,
scope-refactor clean — but the critics surfaced new HIGH bugs the first pass
missed. All fixed + regression-guarded this session:

- [x] **WV2-1 — gemini-cli container-KEY triangle break (HIGH).** `setup`/
  `upgrade` write `mcpServers` to `~/.gemini/settings.json`, but
  `GeminiCLIAdapter.checkPluginRegistration()` only read `extensions` → doctor
  WARNed "not found in extensions" after a clean setup. Fixed: doctor now
  checks `mcpServers` first (then `extensions` for the marketplace path).
  Verified end-to-end (doctor reports PASS). New KEY-agreement regression test
  asserts `checkPluginRegistration()` PASSES on what setup writes.
- [x] **WV2-2 — codex MANUAL_HINTS dead-end (HIGH).** codex was in BOTH
  `MANUAL_HINTS` and `HOOK_CAPABLE`; the manual short-circuit returned before
  the hooks block, so codex's real `configureAllHooks` (writes `hooks.json` +
  feature flag) never ran and doctor reported hooks FAIL. Fixed: removed codex
  from `MANUAL_HINTS` (it now flows through hooks), added `POST_SETUP_NOTES`
  printing the TOML MCP snippet after hooks run. Verified: setup writes 8 hook
  changes + prints TOML note.
- [x] **WV2-3 — `readJsonForMerge` data-loss guard (HIGH).** The old
  `readJsonOrDefault` silently returned `{}` on any parse error, then the
  atomic write WIPED every sibling MCP server + comments (VS Code `mcp.json`
  is officially JSONC). Fixed: parse-error now backs the original up to
  `<path>.broken` (visible + recoverable, like the codex adapter) before
  writing fresh, and `removeMcpRegistration` refuses to touch an unparseable
  file. Verified: a JSONC `.vscode/mcp.json` is backed up, not wiped.
- [x] **WV2-4 — vscode-copilot `--scope user` unreadable by doctor (MED).**
  Doctor read only project `.vscode/mcp.json`; `--scope user` writes
  `~/.vscode/mcp.json`. Fixed: `checkPluginRegistration()` now checks both
  (mirrors cursor's home fallback). KEY-agreement test covers it.
- [x] **WV2-5 — vscode-copilot/jetbrains hook non-idempotency (MED).**
  `copilot-base.configureAllHooks` rewrote unconditionally + always reported
  "applied". Fixed with the DI-1 JSON-compare + write-skip guard.
- [x] **WV2-6 — gemini-cli hook non-idempotency (MED).** `configureAllHooks`
  used a naive `includes("context-mode")` predicate that never matched the
  path-form command, appending a duplicate hook every run (DI-1 guard was dead
  code there). Fixed to use the existing `isContextModeHook` helper.
- [x] **WV2-7 — uninstall hints via naive regex (MED).** `manual.replace(/install/gi,"uninstall")`
  produced `npm run uninstall:openclaw` (no such script) + "Add back the server
  you're removing". Fixed with an explicit `UNINSTALL_HINTS` map.
- [x] **WV2-8 — setup write failures exited 0 (MED).** Hook/MCP catch blocks
  pushed to a discarded `warnings` array; a failed setup printed green
  "complete" + exit 0. Fixed: a real write failure now sets `hadFailure` →
  exit 1.
- [x] **WV2-9 — `--check` always reported drift for hook-capable (MED).**
  Fixed: in check mode hooks no longer contribute to the drift exit code (only
  the deterministic MCP-registration dry-run does), so `--check` is a usable CI
  drift detector. Verified: configured platform → `--check` exit 0.
- [x] **WV2-10 — qwen-code `writeSettings` ENOENT on fresh machine (MED,
  pre-existing, surfaced by WV2-8).** qwen `writeSettings` did `writeFileSync`
  with no parent `mkdir`, throwing ENOENT when `~/.qwen/` didn't exist. Fixed
  with `mkdirSync(dirname(...), {recursive:true})`.
- [x] **WV2-11 — `--force` was dead (LOW).** Now wired into MCP registration
  (re-writes even when up-to-date).
- [x] **WV2-12 — `upsertKey` clobbered user fields (LOW).** MCP registration
  now shallow-merges desired over the existing context-mode entry, preserving
  a user's `env`/`args`.
- [x] **WV2-13 — B4 heal-log `~/.claude` hardcode + unwanted-dir (LOW).**
  postinstall now honors `$CLAUDE_CONFIG_DIR` (mirrors start.mjs), and the
  heal-log is only written when a heal/sweep/error actually happened (no
  unwanted `~/.claude/context-mode/` on a no-op fresh install). Rotation uses
  hysteresis to shrink the concurrent-write race window.

- [ ] **DI-10 — gemini/qwen shared-settings adapter `readSettings` data-loss
  (MED, pre-existing).** For gemini-cli + qwen-code, hooks + mcpServers share
  one `settings.json`; the adapter's `configureAllHooks`→`readSettings` returns
  `{}` on a parse error and rewrites, dropping sibling content. The common
  valid-JSON case is safe (hooks merge preserves mcpServers) and these files
  are strict JSON (not JSONC), so the realistic JSONC data-loss case is
  vscode-copilot's separate `mcp.json` — already covered by WV2-3. The
  adapter-level shared-settings hardening (back up on parse error like
  codex) is left for the maintainer since `readSettings` is shared with the
  upgrade path + many callers.

## Loop verification (run until 0 major issues)

User directive: re-run the whole-branch dynamic workflow (15 platform
triangles + cross-cutting audit, **official docs re-verified each loop**)
until an iteration finds 0 confirmed MAJOR (HIGH) issues. Windows
compatibility is an explicit audit dimension.

### Iteration 1 — 3 MAJOR found + fixed

- [x] **L1-1 (HIGH) zed context_servers shape.** setup wrote nested
  `{ command: { path, args } }`; current Zed only accepts the FLAT
  `{ command: "context-mode", args: [] }` (verified against
  zed-industries/zed `crates/settings_content/src/project.rs` — the Stdio
  variant flattens `ContextServerCommand` and renames `path`→`command`). The
  nested form fails serde under the `#[serde(untagged)]` enum and Zed silently
  drops the server. Fixed `setup.ts` + README + the misleading Note. Guard:
  matrix test asserts zed `command` is a string.
- [x] **L1-2 (HIGH) GitHub Copilot hook shape.** `copilot-base`
  generateHookConfig/configureAllHooks emitted the Claude-Code nested
  `{ matcher, hooks: [...] }`; the Copilot runtime + the maintainer's verified
  templates use FLAT `{ type, command }` — the nested shape never fires. Fixed
  to flat (matches `configs/{vscode,jetbrains}-copilot/hooks.json`). Guards:
  generateHookConfig tests assert no `matcher`/inner `hooks`.
- [x] **L1-3 (HIGH) readJsonForMerge JSONC.** a VALID commented
  `.vscode/mcp.json` (officially JSONC) failed strict parse → backed-up + reset,
  dropping the user's sibling servers. Now strips JSONC comments + trailing
  commas before parse so valid commented files merge in place; only genuinely
  unparseable files get the `.broken` backup.
- [x] **MED/LOW:** uninstall exit code on write failure; CONTEXT_MODE_PLATFORM
  override derived from `REGISTERED_PLATFORM_IDS` (was missing `openclaw`);
  postinstall section-0 + doctor leftover-check honor `$CLAUDE_CONFIG_DIR`;
  omp/pi hints lead with the doctor-read file+key; unknown-platform guard
  (warn + supported list + exit 2); removed stale `@ts-expect-error` (build
  break); publish-tarball file-count budget recalibrated for a built tree.
- **Windows:** all new/changed code uses `resolve()`/`join()`/`homedir()` and
  `~`-expansion handles both separators — no POSIX-only path construction.
- **Deferred (documented):** kilo doctor read-paths (maintainer-verified;
  manual platform); JetBrains `"version":1` (maintainer's verified template
  omits it).
- **Result: FAIL (3 major) → fixed → re-loop.** 936/936 tests, tsc clean.

### Iteration 2 — 2 MAJOR found + fixed (Windows dimension added)

- [x] **L2-1 (HIGH) openclaw upgrade missing MCP sidecar.** `context-mode
  upgrade` → `OpenClawAdapter.configureAllHooks` wrote `plugins.entries` but
  never `mcp.servers.context-mode`, so OpenClaw loaded the plugin with zero
  agent-callable ctx_* tools, and `checkPluginRegistration` (entries-only)
  reported pass. Fixed: configureAllHooks now registers the MCP sidecar +
  `plugins.allow` (mirrors `register-openclaw-config.mjs`); doctor requires
  BOTH entries AND mcp.servers.
- [x] **L2-2 (HIGH) pi global extension path (DI-7 resolved).** The global
  read path omitted the `agent/` segment; Pi auto-discovers from
  `~/.pi/agent/extensions/` (earendil-works/pi — fork lineage confirmed by the
  loop). Fixed checkPluginRegistration / getInstalledVersion / getSettingsPath.
  Project path `.pi/extensions/` was already correct. **DI-7 closed.**
- [x] **MED:** zed doctor parses JSONC (was strict → false-fail); invalid
  explicit platform arg → exit 2 + supported list (keys off
  REGISTERED_PLATFORM_IDS); vscode `--scope user` warns + falls back to
  project (VS Code has no `~/.vscode/mcp.json`); postinstall section 0 gated on
  `isGlobalInstall()`.
- **SOT:** JSONC strip/parse extracted to `src/util/jsonc.ts` (`parseJsonc`),
  shared by zed + setup.ts.
- **Windows (explicit dimension this loop):** no Windows-breaking issue found;
  all changed paths use `resolve()`/`join()`/`homedir()`; openclaw mirrors the
  installer's exact server-bundle path form for install↔upgrade idempotency.
- **Deferred (documented):** kilo `getInstalledVersion` cache path;
  openclaw state-dir write location (both pre-existing; manual/externally-
  managed platforms; primary defects fixed).
- **Result: FAIL (2 major) → fixed → re-loop.** 939 tests pass, tsc clean.

### Iteration 3 — 0 MAJOR (exit condition met) + MED cleanup

- **0 confirmed HIGH** across 15 platform triangles + cross-cutting + Windows
  audit (51 agents, official docs re-verified, adversarial). The loop's
  stop condition (no major issues) is satisfied.
- Audit agents auto-applied a few MEDIUM fixes mid-run; these were reviewed +
  test-verified before keeping (opencode/kilo global-config-dir resolution via
  getConfigDir; kilo/pi hint specificity).
- [x] Fixed this iteration: cli-upgrade-verification.test.ts (5 RED stale
  assertions vs the SOT heal suite — a real branch-RED I introduced with the
  Item-B consolidation); zed Windows path (`zedSettingsPath()` SOT →
  `%LOCALAPPDATA%\Zed`, web-verified — the audit agents' `%APPDATA%\Zed` was
  wrong); jetbrains docs `--adapter` flag (non-existent) → `context-mode
  upgrade`; setup unknown/invalid-arg guard via REGISTERED_PLATFORM_IDS.
- **Windows (user directive):** zed path corrected to `%LOCALAPPDATA%\Zed`;
  opencode/kilo global tier now honors `XDG_CONFIG_HOME`/`APPDATA` via
  getConfigDir. All web-verified.
- [ ] **Deferred (documented, non-blocking):**
  - **opencode getConfigDir APPDATA-vs-xdg on Windows** — official sst/opencode
    uses xdg-basedir (`~/.config`, no APPDATA) on all platforms, but the
    adapter's win32 branch (`%APPDATA%`) carries a maintainer comment citing
    opencode #265/#251/#8235. paths() is now internally consistent with
    getConfigDir either way; flipping getConfigDir overrides that cited fix →
    maintainer call.
  - **openclaw `$OPENCLAW_STATE_DIR` read** — installer writes there; doctor
    reads ~/.openclaw. Externally-managed platform.
  - **valid-JSONC merge drops comments** on the atomic rewrite (servers are
    preserved; only comments are lost) — acceptable, could warn.
  - **upgrade internal doctor-verify runs with cwd=pluginRoot** while writes
    target process.cwd() — project-scoped verify could inspect the wrong dir.
- **Result: PASS — 0 major. Confirmation iteration run against the final tree
  (post-MED-cleanup) to certify stability.** 1108/1108 tests, tsc clean.

### Iteration 4 — CONVERGED (0 major, 0 medium)

Confirmation run against the post-iteration-3 tree: **0 HIGH + 0 MEDIUM**,
only 2 LOW — both fixed:

- [x] **zed args clobber (LOW):** dropped `args: []` from the zed desired so a
  re-run no longer resets a user's hand-edited `context_servers.args`.
- [x] **doctor JSONC consistency (LOW):** routed the config-read paths of the
  6 remaining adapters (gemini-cli, qwen-code, kiro, antigravity,
  vscode-copilot, cursor) through `util/jsonc.parseJsonc`, so doctor reads the
  same commented configs setup writes JSONC-tolerant. zed + openclaw were
  already converted. The `util/jsonc` SOT is now used uniformly. Guard:
  parametrized JSONC test across all 6 + zed.
- Two audit-agent edits this iteration were reviewed + kept (openclaw
  readSettings JSONC; detect.ts header SOT alignment).

**LOOP CONVERGED.** Two consecutive iterations (3 and 4) found 0 major issues;
iteration 4 found 0 medium as well. Trend across the loop: **3 → 2 → 0 → 0**
major. The post-LOW-cleanup tree is 1114/1114 tests, tsc clean. Windows was an
explicit audit dimension throughout (zed `%LOCALAPPDATA%`, opencode/kilo XDG
honored, all paths via resolve/join/homedir).

Net of the whole loop (3 iterations of fixes): every confirmed setup↔doctor
divergence, data-loss path, and platform-load break across all 15 agent CLIs
was fixed + regression-guarded; official docs were re-verified each iteration;
contested pre-existing items (opencode APPDATA-vs-xdg, openclaw state-dir) are
documented for the maintainer rather than blind-edited.

## Open questions

- [ ] `setup` should it accept `--scope user|project|local` like `claude mcp add`?
- [ ] Where does the merge manifest live for adapters whose config has nested arrays (cursor hooks `[{matcher, hooks: [...]}]`)? Need JSON-path or shallow-array dedupe semantics — propose `setup.manifest.json` per adapter that names "owned" keys.
- [ ] OpenClaw / Pi extensions install into `.openclaw/` / `.pi/` — `setup` here is mostly a no-op (their native plugin systems handle MCP registration). Document as "managed externally" rather than running a write.
- [ ] OpenCode / Kilo install via npm into a per-package cache (`~/.cache/opencode/packages/...`). Setup may not need to write anything here either — confirm.
