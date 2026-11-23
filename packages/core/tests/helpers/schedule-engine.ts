import { SchedulerEngine } from "../../src/scheduler/engine.js";
import { MemoryScheduleStore } from "../../src/scheduler/memory.js";
import { AgentRunner } from "../../src/agent-runner.js";
import { EventBus } from "../../src/event-bus.js";
import { InMemorySessionStore } from "../../src/session-store.js";
import { createMockProvider, textResponse } from "./mock-provider.js";

/** Midnight UTC on 1 June 2026: the fake clock's start in end_at tests. */
export const T0 = Date.parse("2026-06-01T00:00:00Z");
export const MIN = 60_000;
export const DAY = 86_400_000;

/** ISO-8601 string for a millisecond timestamp. */
export const iso = (ms: number): string => new Date(ms).toISOString();

/** A scheduler engine over a memory store, with 40 canned "ok" replies. */
export function makeEngine(store = new MemoryScheduleStore()): {
  engine: SchedulerEngine;
  store: MemoryScheduleStore;
} {
  const responses = Array.from({ length: 40 }, () => textResponse("ok"));
  const events = new EventBus();
  const runner = new AgentRunner(createMockProvider(responses), events, new InMemorySessionStore());
  return { engine: new SchedulerEngine(store, runner, events), store };
}
