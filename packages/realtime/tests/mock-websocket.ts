/**
 * Test-only mock WebSocket. Implements the structural slice the client
 * uses (`addEventListener`, `send`, `close`, `readyState`) plus helpers
 * the tests need to drive socket lifecycle from the outside.
 */

import type { WebSocketLike } from "../src/transport.js";

type Listener<E> = (ev: E) => void;

interface MockListeners {
  open: Array<Listener<void>>;
  close: Array<Listener<{ code?: number; reason?: string }>>;
  error: Array<Listener<unknown>>;
  message: Array<Listener<{ data: unknown }>>;
}

export class MockWebSocket implements WebSocketLike {
  static instances: MockWebSocket[] = [];

  /** Reset the static instance log between tests. */
  static reset(): void {
    MockWebSocket.instances = [];
  }

  readyState = 0;
  readonly url: string;
  readonly protocols: string[] | undefined;
  readonly sent: string[] = [];
  private readonly listeners: MockListeners = {
    open: [],
    close: [],
    error: [],
    message: [],
  };

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = typeof protocols === "string" ? [protocols] : protocols;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: "open", listener: Listener<void>): void;
  addEventListener(
    type: "close",
    listener: Listener<{ code?: number; reason?: string }>,
  ): void;
  addEventListener(type: "error", listener: Listener<unknown>): void;
  addEventListener(type: "message", listener: Listener<{ data: unknown }>): void;
  addEventListener(type: keyof MockListeners, listener: Listener<unknown>): void {
    // Type-cast is local to this dispatch table; per-overload signatures
    // above protect callers.
    (this.listeners[type] as Array<Listener<unknown>>).push(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.fireClose({ ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) });
  }

  /** Fire `open` from the test, simulating a successful handshake. */
  fireOpen(): void {
    this.readyState = 1;
    for (const l of this.listeners.open) l();
  }

  /** Fire `error` from the test. */
  fireError(err: unknown): void {
    for (const l of this.listeners.error) l(err);
  }

  /** Deliver an inbound message frame to the client. */
  fireMessage(data: unknown): void {
    for (const l of this.listeners.message) l({ data });
  }

  /** Fire `close` from the test. */
  fireClose(ev: { code?: number; reason?: string } = {}): void {
    for (const l of this.listeners.close) l(ev);
  }
}
