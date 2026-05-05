/**
 * WebSocket transport abstractions for `@tuttiai/realtime`.
 *
 * The Realtime client deliberately depends on a structural slice of the
 * standard WebSocket API rather than a concrete implementation, so the
 * same code runs on Node ≥ 22 (global `WebSocket`) and inside browsers,
 * and so tests can plug in a mock without touching the network.
 */

/** Base URL for the OpenAI Realtime WebSocket endpoint. */
export const REALTIME_URL = "wss://api.openai.com/v1/realtime";

/**
 * Subprotocol token prefix used to forward an OpenAI API key on the
 * WebSocket handshake. Required when the client cannot set custom
 * upgrade headers (browser `WebSocket`, Node global `WebSocket`).
 */
export const SUBPROTOCOL_PREFIX_API_KEY = "openai-insecure-api-key.";

/** Subprotocol token enabling the Realtime beta on the upgrade request. */
export const SUBPROTOCOL_BETA = "openai-beta.realtime-v1";

/**
 * Minimal structural view of the WebSocket API used by the client. Kept
 * so tests can supply a mock and so the package stays usable without a
 * DOM lib in `tsconfig`.
 */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "close",
    listener: (ev: { code?: number; reason?: string }) => void,
  ): void;
  addEventListener(type: "error", listener: (ev: unknown) => void): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
}

/** WebSocket constructor signature accepted by the client. */
export type WebSocketCtor = new (
  url: string,
  protocols?: string | string[],
) => WebSocketLike;

/**
 * Look up the global `WebSocket` constructor, if present. Returns
 * `undefined` on runtimes that don't expose one (e.g. Node < 22 without
 * a polyfill) so callers can produce a clear error.
 */
export function resolveGlobalWebSocket(): WebSocketCtor | undefined {
  const g = globalThis as { WebSocket?: WebSocketCtor };
  return g.WebSocket;
}

/**
 * Build the auth subprotocols accepted by the Realtime API for a given
 * API key. Exposed so callers can audit what is sent on the upgrade.
 */
export function buildAuthSubprotocols(apiKey: string): string[] {
  return [
    "realtime",
    `${SUBPROTOCOL_PREFIX_API_KEY}${apiKey}`,
    SUBPROTOCOL_BETA,
  ];
}
