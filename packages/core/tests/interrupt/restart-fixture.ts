/**
 * Shared fixture for the restart tests: two runtimes over the same stores
 * stand in for one process before a restart and the next one after it.
 */

import { z } from "zod";
import type { ChatResponse, LLMProvider, ScoreConfig, Voice } from "@tuttiai/types";

import { MemoryCheckpointStore } from "../../src/checkpoint/memory.js";
import type { CheckpointStore } from "../../src/checkpoint/store.js";
import { MemoryInterruptStore } from "../../src/interrupt/memory-store.js";
import type { InterruptStore } from "../../src/interrupt/store.js";
import { resumeInFlight } from "../../src/interrupt/live-waiters.js";
import { TuttiRuntime } from "../../src/runtime.js";
import { InMemorySessionStore } from "../../src/session-store.js";

export interface Counts {
  safe_tool: number;
  danger_tool: number;
  slow_tool: number;
}

/** A voice whose tools count their calls. `slow_tool` never finishes. */
export function countingVoice(counts: Counts): Voice {
  const tool = (name: keyof Counts, destructive: boolean, finish: boolean): Voice["tools"][number] => ({
    name,
    description: name,
    parameters: z.object({ path: z.string() }),
    ...(destructive ? { destructive: true } : {}),
    execute: () => {
      counts[name]++;
      return finish ? Promise.resolve({ content: `${name} ok` }) : new Promise(() => undefined);
    },
  });
  return {
    name: "counting",
    required_permissions: [],
    tools: [tool("safe_tool", false, true), tool("danger_tool", true, true), tool("slow_tool", false, false)],
  };
}

/** A response asking for the named tools, all on path "a". */
export function toolCalls(...names: string[]): ChatResponse {
  return {
    id: "r",
    content: names.map((name, i) => ({ type: "tool_use" as const, id: `call-${name}-${i}`, name, input: { path: "a" } })),
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

/** Delegates to a memory store without being one, so the runner treats it as durable. */
export class DurableCheckpoints implements CheckpointStore {
  readonly inner = new MemoryCheckpointStore();
  save: CheckpointStore["save"] = (cp) => this.inner.save(cp);
  loadLatest: CheckpointStore["loadLatest"] = (id) => this.inner.loadLatest(id);
  load: CheckpointStore["load"] = (id, turn) => this.inner.load(id, turn);
  delete: CheckpointStore["delete"] = (id) => this.inner.delete(id);
  list: CheckpointStore["list"] = (id) => this.inner.list(id);
}

/** Delegates to a memory store without being one, so the runner treats it as durable. */
export class DurableInterrupts implements InterruptStore {
  readonly inner = new MemoryInterruptStore();
  create: InterruptStore["create"] = (input) => this.inner.create(input);
  get: InterruptStore["get"] = (id) => this.inner.get(id);
  resolve: InterruptStore["resolve"] = (id, status, options) => this.inner.resolve(id, status, options);
  listPending: InterruptStore["listPending"] = (session) => this.inner.listPending(session);
  listBySession: InterruptStore["listBySession"] = (session) => this.inner.listBySession(session);
}

/** The stores a restart keeps. */
export interface Stores {
  sessions: InMemorySessionStore;
  checkpoints: CheckpointStore;
  interrupts: InterruptStore;
}

export function memoryStores(): Stores {
  return {
    sessions: new InMemorySessionStore(),
    checkpoints: new MemoryCheckpointStore(),
    interrupts: new MemoryInterruptStore(),
  };
}

/** One "process": a runtime over the given stores. */
export function boot(stores: Stores, provider: LLMProvider, voice: Voice): TuttiRuntime {
  const score: ScoreConfig = {
    name: "restart",
    provider,
    agents: {
      worker: { name: "worker", model: "test-model", system_prompt: "Work.", voices: [voice] },
    },
  };
  return new TuttiRuntime(score, {
    sessionStore: stores.sessions,
    checkpointStore: stores.checkpoints,
    interruptStore: stores.interrupts,
  });
}

/** Resolves with the first approval the runtime asks for. */
export function nextApproval(runtime: TuttiRuntime): Promise<{ interrupt_id: string; session_id: string }> {
  return new Promise((resolve) => {
    const off = runtime.events.on("interrupt:requested", (e) => {
      off();
      resolve({ interrupt_id: e.interrupt_id, session_id: e.session_id });
    });
  });
}

/** Resolves with the status of the next approval the runtime resolves. */
export function nextResolution(runtime: TuttiRuntime): Promise<{ status: string; denial_reason?: string }> {
  return new Promise((resolve) => {
    const off = runtime.events.on("interrupt:resolved", (e) => {
      off();
      resolve({ status: e.status, ...(e.denial_reason !== undefined ? { denial_reason: e.denial_reason } : {}) });
    });
  });
}

/** Waits for the background resume of a session, if one is running. */
export async function resumed(runtime: TuttiRuntime, session_id: string): Promise<void> {
  // Safe: `_runner` is the private field `resolveInterrupt` keys its resume
  // by; reading it is the only way to await the background resume here.
  const owner = (runtime as unknown as { _runner: object })._runner;
  await resumeInFlight(owner, session_id);
}
