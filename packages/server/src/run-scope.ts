import { AsyncLocalStorage } from "node:async_hooks";

import type { TuttiRuntime } from "@tuttiai/core";
import type { TuttiEvent } from "@tuttiai/types";

/**
 * Carries the key of the request whose run is executing. One storage
 * for the process; each {@link RunScope} is told apart by its own key.
 */
const activeRun = new AsyncLocalStorage<symbol>();

/** A subscription to runtime events that only sees one request's run. */
export interface RunScope {
  /**
   * Execute `fn` inside this scope. Every event emitted by work that
   * `fn` starts, including its promise continuations and timers, reaches
   * the scoped handler; events from any other run do not.
   */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Stop delivering events to the handler. Safe to call more than once. */
  unsubscribe(): void;
}

/**
 * Subscribe to a runtime's events, filtered to the run a single HTTP
 * request starts.
 *
 * @remarks
 * The runtime's event bus is shared by every request on the server, and
 * several events (`token:stream`, `tool:start`, `tool:end`) name no
 * session. A request also cannot know its session id in advance when
 * the runtime creates the session. Filtering by execution context
 * instead of by payload solves both: `EventBus.emit` calls handlers
 * synchronously, so a handler reads the async context of the code that
 * emitted, which belongs to exactly one request's run. It also covers
 * graph runs, whose nodes each open their own session.
 *
 * @param events  - The runtime's event bus.
 * @param handler - Receives only the events emitted inside {@link RunScope.run}.
 * @returns A scope to run the request's work in, and its unsubscribe.
 *
 * @example
 * const scope = scopeRunEvents(runtime.events, (e) => forward(e));
 * try {
 *   await scope.run(() => runtime.run(agent, input));
 * } finally {
 *   scope.unsubscribe();
 * }
 */
export function scopeRunEvents(
  events: TuttiRuntime["events"],
  handler: (event: TuttiEvent) => void,
): RunScope {
  const scopeKey = Symbol("run-scope");
  const unsubscribe = events.onAny((e: TuttiEvent) => {
    if (activeRun.getStore() === scopeKey) handler(e);
  });
  return {
    run: <T>(fn: () => Promise<T>): Promise<T> => activeRun.run(scopeKey, fn),
    unsubscribe,
  };
}
