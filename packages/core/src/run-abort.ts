import type { ChatRequest } from "@tuttiai/types";

import { RunAbortedError } from "./errors.js";
import { SecretsManager } from "./secrets.js";

/**
 * Cancellation for a run, driven by `AgentRunOptions.signal`.
 *
 * A caller that gives up on a run (an HTTP client that disconnected, a
 * timeout) aborts the signal. The runner then stops at its next safe point:
 * before a model call, before a tool call, or while a tool call waits for
 * approval. Nothing here kills work already handed to a tool; the point is
 * that nothing new starts once nobody is listening.
 */

/**
 * The error a run ends with once its signal is aborted.
 *
 * @param signal - The aborted signal.
 * @returns A {@link RunAbortedError} carrying the signal's reason, redacted.
 */
export function abortError(signal: AbortSignal): RunAbortedError {
  return new RunAbortedError(SecretsManager.redact(describeReason(signal.reason)));
}

/**
 * Throw when the signal has been aborted. A no-op without a signal.
 *
 * @param signal - The run's signal, if it has one.
 * @throws {RunAbortedError} When the signal is aborted.
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

/**
 * Settle with `work`, or reject as soon as the signal aborts, whichever is
 * first. `work` keeps running after an abort; its result is discarded.
 *
 * @param work - The pending work.
 * @param signal - The run's signal.
 * @param onAbort - Called once if the signal aborts first, to release what `work` waits on.
 * @returns What `work` resolves to.
 * @throws {RunAbortedError} When the signal aborts first, or was already aborted.
 */
export async function raceAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  // Checked first: racing an already-settled `work` would let it win.
  if (signal.aborted) {
    void Promise.allSettled([work]); // a later rejection of the discarded work is not unhandled
    onAbort?.();
    throw abortError(signal);
  }
  let detach = (): void => undefined;
  const aborted = new Promise<never>((_, reject) => {
    const abort = (): void => {
      onAbort?.();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    detach = () => signal.removeEventListener("abort", abort);
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    detach();
  }
}

/**
 * Start `work` unless the signal is already aborted, and stop waiting on it
 * when the signal aborts. Without a signal it simply runs `work`.
 *
 * @param signal - The run's signal, if it has one.
 * @param work - Starts the work, such as a model call.
 * @returns What `work` resolves to.
 * @throws {RunAbortedError} When the signal is or becomes aborted first.
 */
export async function abortable<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  if (!signal) return work();
  throwIfAborted(signal);
  return raceAbort(work(), signal);
}

/**
 * The request a provider receives: the same request carrying the run's
 * signal. Added only at the call, so hooks and `llm:request` events never
 * hold a non-serialisable signal.
 *
 * @param request - The request as hooks and events saw it.
 * @param signal - The run's signal, if it has one.
 * @returns The request, with `signal` set when there is one.
 */
export function withSignal(request: ChatRequest, signal: AbortSignal | undefined): ChatRequest {
  return signal ? { ...request, signal } : request;
}

function describeReason(reason: unknown): string {
  if (typeof reason === "string" && reason !== "") return reason;
  if (reason instanceof Error && reason.message !== "") return reason.message;
  return "the run's signal was aborted";
}
