/**
 * Unit tests for the pure aggregation helper used by `GET /cost/tools`.
 *
 * The route handler itself is a one-liner over this function; covering
 * the aggregation here lets us assert the live-window framing math
 * without spinning up a Fastify instance.
 */

import { describe, expect, it } from "vitest";
import type { TuttiSpan } from "@tuttiai/core";

import { aggregateToolUsage } from "../src/routes/cost.js";

function span(partial: Partial<TuttiSpan> & { name: string; trace_id: string }): TuttiSpan {
  return {
    span_id: partial.span_id ?? "s-" + Math.random().toString(36).slice(2),
    trace_id: partial.trace_id,
    ...(partial.parent_span_id !== undefined ? { parent_span_id: partial.parent_span_id } : {}),
    name: partial.name,
    kind: partial.kind ?? "tool",
    started_at: partial.started_at ?? new Date(),
    ...(partial.ended_at !== undefined ? { ended_at: partial.ended_at } : {}),
    ...(partial.duration_ms !== undefined ? { duration_ms: partial.duration_ms } : {}),
    status: partial.status ?? "ok",
    attributes: partial.attributes ?? {},
    ...(partial.error !== undefined ? { error: partial.error } : {}),
  };
}

describe("aggregateToolUsage", () => {
  it("returns an empty list when no tool spans are present", () => {
    const out = aggregateToolUsage([
      span({ name: "agent.run", kind: "agent", trace_id: "t1" }),
    ]);
    expect(out.tools).toEqual([]);
    expect(out.window_span_count).toBe(1);
  });

  it("counts tool.call spans by tool_name and sums LLM tokens by trace", () => {
    const spans: TuttiSpan[] = [
      span({
        name: "tool.call",
        trace_id: "t1",
        attributes: { tool_name: "read_file" },
      }),
      span({
        name: "tool.call",
        trace_id: "t1",
        attributes: { tool_name: "read_file" },
      }),
      span({
        name: "llm.completion",
        kind: "llm",
        trace_id: "t1",
        attributes: { total_tokens: 1000 },
      }),
      span({
        name: "tool.call",
        trace_id: "t2",
        attributes: { tool_name: "read_file" },
      }),
      span({
        name: "llm.completion",
        kind: "llm",
        trace_id: "t2",
        attributes: { total_tokens: 500 },
      }),
    ];

    const out = aggregateToolUsage(spans);
    expect(out.tools).toHaveLength(1);
    const row = out.tools[0]!;
    expect(row.tool_name).toBe("read_file");
    expect(row.call_count).toBe(3);
    // Total tokens: t1 (1000) + t2 (500) = 1500 (each contributing trace
    // is counted once even though t1 had 2 calls).
    expect(row.total_llm_tokens).toBe(1500);
    expect(row.avg_llm_tokens_per_call).toBeCloseTo(1500 / 3, 5);
  });

  it("sorts tools by call_count desc", () => {
    const spans: TuttiSpan[] = [
      span({ name: "tool.call", trace_id: "t", attributes: { tool_name: "read_file" } }),
      span({ name: "tool.call", trace_id: "t", attributes: { tool_name: "search" } }),
      span({ name: "tool.call", trace_id: "t", attributes: { tool_name: "search" } }),
      span({ name: "tool.call", trace_id: "t", attributes: { tool_name: "search" } }),
    ];
    const out = aggregateToolUsage(spans);
    expect(out.tools.map((t) => t.tool_name)).toEqual(["search", "read_file"]);
  });

  it("ignores tool spans without a tool_name attribute", () => {
    const spans: TuttiSpan[] = [
      span({ name: "tool.call", trace_id: "t", attributes: {} }),
      span({ name: "tool.call", trace_id: "t", attributes: { tool_name: "read_file" } }),
    ];
    const out = aggregateToolUsage(spans);
    expect(out.tools).toHaveLength(1);
    expect(out.tools[0]?.tool_name).toBe("read_file");
    expect(out.tools[0]?.call_count).toBe(1);
  });

  it("reports the earliest span's started_at as window_started_at", () => {
    const earliest = new Date("2026-05-01T00:00:00Z");
    const later = new Date("2026-05-02T00:00:00Z");
    const out = aggregateToolUsage([
      span({ name: "tool.call", trace_id: "t", started_at: later, attributes: { tool_name: "x" } }),
      span({
        name: "tool.call",
        trace_id: "t",
        started_at: earliest,
        attributes: { tool_name: "x" },
      }),
    ]);
    expect(out.window_started_at).toBe(earliest.toISOString());
  });
});
