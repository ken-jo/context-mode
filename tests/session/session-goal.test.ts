/**
 * Session goal persistence.
 *
 * Before this, a `/goal <text>` directive was never preserved: extractIntent
 * stored only a coarse mode ("investigate"/"implement") and discarded the goal
 * text, so the objective was lost across compaction and resume. These tests
 * cover the two halves of the fix:
 *   1. capture — extractUserEvents turns a `/goal` (or goal: / objective:)
 *      directive into a first-class `goal` event holding the full text;
 *   2. restore — buildResumeSnapshot surfaces the latest goal verbatim in a
 *      <session_goal> section, placed first so the resuming LLM reads it.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "vitest";
import { extractUserEvents } from "../../src/session/extract.js";
import { buildResumeSnapshot, type StoredEvent } from "../../src/session/snapshot.js";

function makeEvent(
  overrides: Partial<StoredEvent> & Pick<StoredEvent, "type" | "category">,
): StoredEvent {
  return {
    type: overrides.type,
    category: overrides.category,
    data: overrides.data ?? "",
    priority: overrides.priority ?? 2,
    created_at: overrides.created_at ?? new Date().toISOString(),
  };
}

const goalOf = (msg: string) =>
  extractUserEvents(msg).find((e) => e.category === "goal")?.data;

describe("capture: extractGoal", () => {
  test("captures the full text of a /goal command (not just a mode)", () => {
    assert.equal(goalOf("/goal ship the v2 release by Friday"), "ship the v2 release by Friday");
  });

  test("captures goal: / objective: markers (case-insensitive)", () => {
    assert.equal(goalOf("goal: migrate auth to OAuth"), "migrate auth to OAuth");
    assert.equal(goalOf("Objective: cut p95 latency in half"), "cut p95 latency in half");
  });

  test("ignores ordinary prompts and bare/empty directives", () => {
    assert.equal(goalOf("please refactor the parser"), undefined);
    assert.equal(goalOf("what is the goal here?"), undefined);
    assert.equal(goalOf("/goal"), undefined);
    assert.equal(goalOf("/goal    "), undefined);
  });

  test("a /goal directive still has priority 1 (critical) so it survives trimming", () => {
    const ev = extractUserEvents("/goal keep tests green").find((e) => e.category === "goal");
    assert.equal(ev?.priority, 1);
  });
});

describe("restore: buildResumeSnapshot", () => {
  test("surfaces the latest goal verbatim in a <session_goal> section", () => {
    const xml = buildResumeSnapshot([
      makeEvent({ type: "goal", category: "goal", data: "ship the v2 release", priority: 1 }),
      makeEvent({ type: "goal", category: "goal", data: "ship the v2 release AND cut latency", priority: 1 }),
    ]);
    assert.match(xml, /<session_goal>/);
    assert.match(xml, /ship the v2 release AND cut latency/); // latest wins
    assert.doesNotMatch(xml, /<session_goal>[\s\S]*ship the v2 release<\/session_goal>/); // not the stale one alone
  });

  test("places the goal before the files section so the LLM reads it first", () => {
    const xml = buildResumeSnapshot([
      makeEvent({ type: "file_edit", category: "file", data: "src/server.ts", priority: 1 }),
      makeEvent({ type: "goal", category: "goal", data: "finish the migration", priority: 1 }),
    ]);
    assert.ok(xml.indexOf("<session_goal>") < xml.indexOf("<files"), "goal must precede files");
  });

  test("no goal events → no <session_goal> section", () => {
    const xml = buildResumeSnapshot([
      makeEvent({ type: "file_edit", category: "file", data: "src/server.ts", priority: 1 }),
    ]);
    assert.doesNotMatch(xml, /<session_goal>/);
  });
});
