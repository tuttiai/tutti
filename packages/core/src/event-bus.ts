import type { TuttiEvent, TuttiEventType } from "@tuttiai/types";
import { SecretsManager } from "./secrets.js";

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
    const handlers = this.listeners.get(type)!;
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
    this.listeners.get(type)?.delete(handler as Handler);
  }

  emit(event: TuttiEvent): void {
    const redacted = SecretsManager.redactObject(event) as TuttiEvent;

    const handlers = this.listeners.get(redacted.type);
    if (handlers) {
      for (const handler of handlers) {
        (handler as (event: TuttiEvent) => void)(redacted);
      }
    }

    // Also notify wildcard listeners
    const wildcardHandlers = this.listeners.get("*");
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        (handler as (event: TuttiEvent) => void)(redacted);
      }
    }
  }

  /** Subscribe to all events. */
  onAny(handler: (event: TuttiEvent) => void): () => void {
    if (!this.listeners.has("*")) {
      this.listeners.set("*", new Set());
    }
    const handlers = this.listeners.get("*")!;
    const h = handler as Handler;
    handlers.add(h);

    return () => {
      handlers.delete(h);
    };
  }
}
