import type { EventBus } from "../event-bus.js";
import { SecretsManager } from "../secrets.js";

/**
 * The tags every `delegate:delta` of one `delegate_to_agent` call carries,
 * and the run's signal. Internal to `@tuttiai/core`.
 */
export interface DeltaTags {
  parent_session_id: string;
  root_session_id: string;
  tool_call_id: string;
  from: string;
  to: string;
  /** The specialist's session: only its `token:stream` events are forwarded. */
  session_id: string;
  path: string[];
  signal?: AbortSignal;
}

/**
 * Forward a specialist's `token:stream` events as `delegate:delta` events on
 * the same bus, each chunk redacted by {@link SecretsManager.redact}. Stops
 * forwarding as soon as `tags.signal` aborts. Call the returned function
 * before the call's terminal event so no delta can follow it.
 *
 * @param events - The runtime's event bus.
 * @param tags - The call's tags and signal.
 * @returns A function that stops forwarding and removes the listener.
 */
export function forwardDeltas(events: EventBus, tags: DeltaTags): () => void {
  const { signal, ...payload } = tags;
  return events.on("token:stream", (event) => {
    if (event.session_id !== payload.session_id || signal?.aborted === true) return;
    const text = SecretsManager.redact(event.text);
    if (text.length === 0) return;
    events.emit({
      type: "delegate:delta",
      ...payload,
      path: [...payload.path],
      depth: payload.path.length,
      text,
    });
  });
}
