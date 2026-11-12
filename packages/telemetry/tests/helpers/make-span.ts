import type { TuttiSpan } from "../../src/types.js";

/** A closed span with fixed ids and times; override what the test needs. */
export function makeSpan(overrides: Partial<TuttiSpan>): TuttiSpan {
  return {
    span_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    trace_id: "0f8fad5b-d9cb-469f-a165-70867728950e",
    name: "agent.run",
    kind: "agent",
    started_at: new Date("2026-11-01T10:00:00.000Z"),
    ended_at: new Date("2026-11-01T10:00:01.000Z"),
    duration_ms: 1000,
    status: "ok",
    attributes: {},
    ...overrides,
  };
}
