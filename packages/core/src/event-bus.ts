import type { TuttiEvent, TuttiEventType } from "@tuttiai/types";
import { SecretsManager } from "./secrets.js";
import { logger } from "./logger.js";

type Handler = (event: never) => void;

export class EventBus {
  private listeners = new Map<string, Set<Handler>>();

  on<T extends TuttiEventType>(
    type: T,
    handler: (event: Extract<TuttiEvent, { type: T }>) => void,
  ): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    const handlers = this.listeners.get(type);
    if (!handlers) return () => {};
    const h = handler as Handler;
    handlers.add(h);

    return () => {
      handlers.delete(h);
    };
  }

  off<T extends TuttiEventType>(
    type: T,
    handler: (event: Extract<TuttiEvent, { type: T }>) => void,
  ): void {
    this.listeners.get(type)?.delete(handler);
  }

  emit(event: TuttiEvent): void {
    const redacted = SecretsManager.redactObject(event) as TuttiEvent;

    const handlers = this.listeners.get(redacted.type);
    if (handlers) {
      for (const handler of handlers) {
        this.invokeHandler(handler, redacted);
      }
    }

    // Also notify wildcard listeners
    const wildcardHandlers = this.listeners.get("*");
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        this.invokeHandler(handler, redacted);
      }
    }
  }

  /**
   * Invoke a subscriber safely. A thrown exception (or a rejected async
   * handler) from user code must not crash the agent run — we log it and
   * keep iterating siblings. This also prevents a single bad telemetry
   * handler from taking down the whole process.
   */
  private invokeHandler(handler: Handler, event: TuttiEvent): void {
    try {
      const ret = (handler as (e: TuttiEvent) => unknown)(event);
      // Async handler: attach a rejection trap so unhandled rejections
      // don't bubble to the process.
      if (ret && typeof (ret as { then?: unknown }).then === "function") {
        (ret as Promise<unknown>).catch((err: unknown) => {
          logger.warn(
            { error: err instanceof Error ? err.message : String(err), event: event.type },
            "Async event handler rejected (non-fatal)",
          );
        });
      }
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err), event: event.type },
        "Event handler threw (non-fatal)",
      );
    }
  }

  /** Subscribe to all events. */
  onAny(handler: (event: TuttiEvent) => void): () => void {
    if (!this.listeners.has("*")) {
      this.listeners.set("*", new Set());
    }
    const handlers = this.listeners.get("*");
    if (!handlers) return () => {};
    const h = handler as Handler;
    handlers.add(h);

    return () => {
      handlers.delete(h);
    };
  }
}
