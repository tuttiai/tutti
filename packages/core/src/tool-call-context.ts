import { z } from "zod";
import type { ToolContext } from "@tuttiai/types";
import type { EventBus } from "./event-bus.js";
import { ToolTimeoutError } from "./errors.js";
import { SecretsManager } from "./secrets.js";
import { logger } from "./logger.js";

/** Longest `message` a `tool:progress` event carries, in characters. */
export const PROGRESS_MESSAGE_MAX = 500;

/** Shape of a progress update; tool code is not trusted to send numbers. */
const ProgressUpdateSchema = z.object({
  progress: z.number().finite().optional(),
  total: z.number().finite().optional(),
  message: z.string().optional(),
  task_id: z.string().optional(),
  status: z.string().optional(),
  source: z.string().optional(),
});

/** What one tool call needs to build its context. Internal to `@tuttiai/core`. */
export interface CallContextDeps {
  /** The tool_use block the call answers. */
  block: { id: string; name: string };
  /** The runtime's event bus, where `tool:progress` goes. */
  events: EventBus;
  /** The run's signal; aborting it aborts the call's signal. */
  runSignal?: AbortSignal;
}

/** The context handed to one tool call, with the handles that end it. */
export interface CallContext {
  /** A copy of the turn's context with this call's `signal` and `report_progress`. */
  context: ToolContext;
  /** Owns `context.signal`. */
  controller: AbortController;
  /** Aborts the call's signal when `error` is a timeout, then rethrows it. */
  fail(error: unknown): never;
  /** Ends the call: drops later progress and unlinks the run's signal. */
  settle(): void;
}

/**
 * Build the context for one tool call. The turn's `toolContext` is shared by
 * the calls of a turn that run in parallel, so each call gets a copy with a
 * signal of its own, linked to the run's signal by hand so the listener can
 * be removed when the call ends.
 *
 * @param base - The turn's shared tool context. Not modified.
 * @param deps - The tool_use block, the event bus and the run's signal.
 * @returns The call's context and the functions that end it.
 */
export function callContext(base: ToolContext, deps: CallContextDeps): CallContext {
  const controller = new AbortController();
  const unlink = linkSignal(deps.runSignal, controller);
  let settled = false;
  const report = (update: unknown): void => {
    if (settled || controller.signal.aborted) return;
    emitProgress(base, deps, update);
  };
  return {
    context: { ...base, signal: controller.signal, report_progress: report },
    controller,
    fail(error: unknown): never {
      if (error instanceof ToolTimeoutError) controller.abort(error);
      throw error;
    },
    settle(): void {
      settled = true;
      unlink();
    },
  };
}

function linkSignal(run: AbortSignal | undefined, controller: AbortController): () => void {
  if (!run) return () => {};
  if (run.aborted) {
    controller.abort(run.reason);
    return () => {};
  }
  const onAbort = (): void => controller.abort(run.reason);
  run.addEventListener("abort", onAbort, { once: true });
  return () => run.removeEventListener("abort", onAbort);
}

function emitProgress(base: ToolContext, deps: CallContextDeps, update: unknown): void {
  const parsed = ProgressUpdateSchema.safeParse(update);
  if (!parsed.success) {
    logger.debug({ tool: deps.block.name }, "Dropped a malformed tool progress update");
    return;
  }
  const { message, ...rest } = parsed.data;
  deps.events.emit({
    type: "tool:progress",
    agent_name: base.agent_name,
    session_id: base.session_id,
    tool_name: deps.block.name,
    tool_call_id: deps.block.id,
    ...rest,
    ...(message !== undefined ? { message: capMessage(message) } : {}),
  });
}

/** Redact before cutting, so the cut cannot split a secret past its pattern. */
function capMessage(message: string): string {
  return SecretsManager.redact(message).slice(0, PROGRESS_MESSAGE_MAX);
}
