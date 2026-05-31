#!/usr/bin/env node
/**
 * preinstall — runs BEFORE npm/pnpm/yarn/bun downloads the dependency tree.
 *
 * Item C1 of docs/setup-improvements.md: catch unsupported Linux + Node<22.5
 * combinations here so the user does not pay the ~30MB / ~10s install cost
 * before learning the install will hard-fail at postinstall anyway.
 *
 * Belt-and-suspenders: scripts/postinstall.mjs still runs the same check
 * because some sandboxed CI runners and some pnpm modes skip preinstall.
 * Both call sites share `scripts/lib/runtime-precheck.mjs` as the single
 * source of truth.
 */

import { runRuntimePrecheck } from "./lib/runtime-precheck.mjs";

runRuntimePrecheck({ phase: "preinstall" });
