import type { TuttiSpan } from "../../src/types.js";

/** Fixed ids so the exported payload is the same on every run. */
export const TRACE_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
export const ROOT_SPAN_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
export const RUNNING_SPAN_ID = "9b2f1c4e-3d5a-4e6f-8a7b-1c2d3e4f5a6b";

function closed(
  span: Omit<TuttiSpan, "trace_id" | "started_at" | "ended_at" | "duration_ms">,
  startIso: string,
  durationMs: number,
): TuttiSpan {
  const started = new Date(startIso);
  return {
    trace_id: TRACE_ID,
    started_at: started,
    ended_at: new Date(started.getTime() + Math.round(durationMs)),
    duration_ms: durationMs,
    ...span,
  };
}

/** One span of each kind, an error span and a running parent, as core emits them today. */
export function fixtureSpans(): TuttiSpan[] {
  return [
    closed({ span_id: ROOT_SPAN_ID, name: "agent.run", kind: "agent", status: "ok",
      attributes: { agent_id: "assistant", session_id: "sess-1", model: "claude-sonnet-4-5" } },
      "2026-11-01T10:00:00.000Z", 2500),
    closed({ span_id: "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d", parent_span_id: ROOT_SPAN_ID,
      name: "llm.completion", kind: "llm", status: "ok",
      attributes: { model: "claude-sonnet-4-5", prompt_tokens: 1200, completion_tokens: 340,
        total_tokens: 1540, cache_read_tokens: 800, cache_creation_tokens: 100,
        cost_usd: 0.0123, router_tier: "medium", auto_routed: true } },
      "2026-11-01T10:00:00.100Z", 1234.5),
    closed({ span_id: "2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e", parent_span_id: ROOT_SPAN_ID,
      name: "tool.call", kind: "tool", status: "ok",
      attributes: { tool_name: "read_file", tool_input: { path: "/tmp/a.txt", lines: [1, 2] },
        tool_output: "file body" } },
      "2026-11-01T10:00:01.400Z", 12),
    closed({ span_id: "3c4d5e6f-7a8b-4c3d-8e4f-5a6b7c8d9e0f", parent_span_id: ROOT_SPAN_ID,
      name: "guardrail", kind: "guardrail", status: "ok",
      attributes: { guardrail_name: "pii", guardrail_action: "redact" } },
      "2026-11-01T10:00:01.500Z", 3),
    closed({ span_id: "4d5e6f7a-8b9c-4d4e-9f5a-6b7c8d9e0f1a", parent_span_id: ROOT_SPAN_ID,
      name: "checkpoint", kind: "checkpoint", status: "ok", attributes: { session_id: "sess-1" } },
      "2026-11-01T10:00:02.000Z", 7),
    closed({ span_id: "5e6f7a8b-9c0d-4e5f-8a6b-7c8d9e0f1a2b", parent_span_id: RUNNING_SPAN_ID,
      name: "tool.call", kind: "tool", status: "error",
      attributes: { tool_name: "write_file", tool_input: { path: "x" } },
      error: { message: "boom", stack: "Error: boom\n    at write" } },
      "2026-11-01T10:00:03.000Z", 40),
    { span_id: RUNNING_SPAN_ID, trace_id: TRACE_ID, name: "agent.run", kind: "agent",
      started_at: new Date("2026-11-01T10:00:02.900Z"), status: "running",
      attributes: { agent_id: "writer" } },
  ];
}
