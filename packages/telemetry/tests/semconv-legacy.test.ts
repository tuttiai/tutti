import { describe, expect, it } from "vitest";

import { legacySpanNaming, toAttributeValue } from "../src/semconv/naming.js";
import type { TuttiSpan } from "../src/types.js";

function span(overrides: Partial<TuttiSpan>): TuttiSpan {
  return {
    span_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    trace_id: "0f8fad5b-d9cb-469f-a165-70867728950e",
    name: "tool.call",
    kind: "tool",
    started_at: new Date("2026-11-01T10:00:00.000Z"),
    status: "ok",
    attributes: {},
    ...overrides,
  };
}

describe("legacySpanNaming", () => {
  it("keeps the span name and every set attribute, then adds tutti.kind", () => {
    const result = legacySpanNaming(
      span({ attributes: { tool_name: "read_file", tool_input: { path: "a" } } }),
    );
    expect(result).toEqual({
      name: "tool.call",
      attributes: { tool_name: "read_file", tool_input: '{"path":"a"}', "tutti.kind": "tool" },
    });
  });

  it("leaves out attributes that are null or undefined", () => {
    const result = legacySpanNaming(
      span({ kind: "agent", name: "agent.run", attributes: { agent_id: undefined, model: "m" } }),
    );
    expect(Object.keys(result.attributes)).toEqual(["model", "tutti.kind"]);
  });
});

describe("toAttributeValue", () => {
  it("passes primitives and arrays of one primitive type through", () => {
    expect(toAttributeValue("a")).toBe("a");
    expect(toAttributeValue(0)).toBe(0);
    expect(toAttributeValue(false)).toBe(false);
    expect(toAttributeValue(["a", "b"])).toEqual(["a", "b"]);
    expect(toAttributeValue([1, 2])).toEqual([1, 2]);
    expect(toAttributeValue([true])).toEqual([true]);
  });

  it("stringifies mixed arrays and objects", () => {
    expect(toAttributeValue([1, "a"])).toBe('[1,"a"]');
    expect(toAttributeValue({ a: 1 })).toBe('{"a":1}');
  });

  it("falls back to the object tag when JSON.stringify throws", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(toAttributeValue(circular)).toBe("[object Object]");
    expect(toAttributeValue(10n)).toBe("[object BigInt]");
  });

  it("returns undefined for null and undefined", () => {
    expect(toAttributeValue(null)).toBeUndefined();
    expect(toAttributeValue(undefined)).toBeUndefined();
  });
});
