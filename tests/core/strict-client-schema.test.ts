import { describe, it, expect } from "vitest";
import { sanitizeSchemaForStrictClients } from "../../src/server.js";

// Gemini's function-calling API (Antigravity CLI `agy`, Gemini CLI) rejects
// JSON Schema `const` and `additionalProperties` and then silently drops the
// tool from the model's function list. The sanitizer rewrites the EMITTED
// tools/list schema in a behavior-preserving way so those tools become callable.
describe("sanitizeSchemaForStrictClients", () => {
  it("rewrites `const: X` to `enum: [X]` (an identical single-value constraint)", () => {
    expect(sanitizeSchemaForStrictClients({ const: "javascript" })).toEqual({ enum: ["javascript"] });
    expect(sanitizeSchemaForStrictClients({ const: 1 })).toEqual({ enum: [1] });
  });

  it("strips `additionalProperties` (advisory-only — Zod validates args server-side)", () => {
    const out = sanitizeSchemaForStrictClients({
      type: "object",
      additionalProperties: false,
      properties: { a: { type: "string" } },
    }) as Record<string, unknown>;
    expect(out).not.toHaveProperty("additionalProperties");
    expect(out.type).toBe("object");
    expect(out.properties).toEqual({ a: { type: "string" } });
  });

  it("preserves every Gemini-compatible keyword unchanged", () => {
    // enum / pattern / default / minLength etc. are accepted by Gemini and must
    // pass through untouched so non-Gemini clients see an identical schema.
    const input = {
      type: "string",
      enum: ["a", "b"],
      pattern: "^x",
      default: "a",
      minLength: 1,
      description: "desc",
    };
    expect(sanitizeSchemaForStrictClients(input)).toEqual(input);
  });

  it("recurses through nested properties and arrays", () => {
    const input = {
      type: "object",
      additionalProperties: false,
      properties: {
        language: { const: "shell" },
        items: { type: "array", items: { const: 1 }, additionalProperties: true },
      },
    };
    expect(sanitizeSchemaForStrictClients(input)).toEqual({
      type: "object",
      properties: {
        language: { enum: ["shell"] },
        items: { type: "array", items: { enum: [1] } },
      },
    });
  });

  it("leaves primitives and null untouched", () => {
    expect(sanitizeSchemaForStrictClients("x")).toBe("x");
    expect(sanitizeSchemaForStrictClients(7)).toBe(7);
    expect(sanitizeSchemaForStrictClients(true)).toBe(true);
    expect(sanitizeSchemaForStrictClients(null)).toBe(null);
  });

  it("does not mutate the input object", () => {
    const input = { const: "x", additionalProperties: false };
    sanitizeSchemaForStrictClients(input);
    expect(input).toEqual({ const: "x", additionalProperties: false });
  });
});
