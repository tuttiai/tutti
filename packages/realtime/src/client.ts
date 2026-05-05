import { Buffer } from "node:buffer";

import { buildSessionUpdate, parseEvent, toError } from "./event-codec.js";
import {
  REALTIME_URL,
  buildAuthSubprotocols,
  resolveGlobalWebSocket,
  type WebSocketCtor,
  type WebSocketLike,
} from "./transport.js";
import {
  REALTIME_WILDCARD_EVENT,
  type RealtimeConfig,
  type RealtimeConnectionState,
  type RealtimeEvent,
  type RealtimeEventHandler,
} from "./types.js";

/** Options for {@link RealtimeClient}. */
export interface RealtimeClientOptions {
  /** Override the WebSocket constructor — defaults to `globalThis.WebSocket`. Tests inject a mock here. */
  websocketCtor?: WebSocketCtor;
}

/**
 * Thin event-driven client over the OpenAI Realtime API WebSocket
 * protocol. Opens / closes the socket, serialises outbound events,
 * parses inbound frames, and dispatches them to subscribers keyed by
 * `event.type`. Higher-level concerns (audio I/O, tool dispatch,
 * session policies) live in consumers of this package.
 */
export class RealtimeClient {
  private readonly websocketCtor: WebSocketCtor;
  private readonly handlers = new Map<string, Set<RealtimeEventHandler>>();
  private socket: WebSocketLike | null = null;
  private state: RealtimeConnectionState = "idle";

  constructor(options: RealtimeClientOptions = {}) {
    const ctor = options.websocketCtor ?? resolveGlobalWebSocket();
    if (!ctor) {
      throw new Error(
        "No WebSocket implementation available. Pass `websocketCtor` or run on Node ≥ 22.",
      );
    }
    this.websocketCtor = ctor;
  }

  /**
   * Open a WebSocket connection to the Realtime API. Resolves once the
   * socket transitions to `open` and the initial `session.update` has
   * been sent.
   *
   * @param apiKey - OpenAI API key for authentication.
   * @param config - Session configuration. The model is encoded into the
   *   URL; remaining fields are sent in a `session.update` event.
   * @throws When the client is already connecting or open, or when the
   *   socket errors during the handshake.
   */
  async connect(apiKey: string, config: RealtimeConfig): Promise<void> {
    if (this.state !== "idle" && this.state !== "closed") {
      throw new Error(`Cannot connect: client is in '${this.state}' state.`);
    }
    const url = `${REALTIME_URL}?model=${encodeURIComponent(config.model)}`;
    const Ctor = this.websocketCtor;
    this.state = "connecting";
    const socket = new Ctor(url, buildAuthSubprotocols(apiKey));
    this.socket = socket;
    try {
      await this.awaitOpen(socket);
    } catch (err) {
      this.state = "closed";
      this.socket = null;
      throw err;
    }
    this.state = "open";
    this.attachLifecycleHandlers(socket);
    this.send(buildSessionUpdate(config));
  }

  /** Close the WebSocket if one is open. Safe to call from any state. */
  disconnect(): void {
    if (!this.socket) {
      this.state = "closed";
      return;
    }
    this.state = "closing";
    try {
      this.socket.close();
    } finally {
      this.socket = null;
      this.state = "closed";
    }
  }

  /**
   * Append a chunk of 16-bit PCM audio to the input buffer. The server
   * processes audio asynchronously; call {@link commitAudio} to mark
   * end-of-utterance when not relying on server VAD.
   */
  sendAudio(pcm16Buffer: Buffer): void {
    this.send({
      type: "input_audio_buffer.append",
      audio: pcm16Buffer.toString("base64"),
    });
  }

  /** Commit the buffered audio as a single user turn. */
  commitAudio(): void {
    this.send({ type: "input_audio_buffer.commit" });
  }

  /** Send a text user message. The server emits a response turn. */
  sendText(text: string): void {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
  }

  /**
   * Send an arbitrary event over the open socket. Used by higher-level
   * helpers (tool bridge, voice adapters) for wire shapes that
   * `sendText`/`sendAudio`/`commitAudio` don't cover (e.g.
   * `session.update`, `function_call_output`, `response.create`).
   *
   * @throws when the client is not in the `open` state.
   */
  send(event: RealtimeEvent): void {
    this.requireOpen();
    if (!this.socket) throw new Error("Not connected.");
    this.socket.send(JSON.stringify(event));
  }

  /**
   * Subscribe to events of a given type. Pass `'*'` (or
   * {@link REALTIME_WILDCARD_EVENT}) to receive every event. Returns an
   * idempotent unsubscribe function.
   */
  on(eventType: string, handler: RealtimeEventHandler): () => void {
    let set = this.handlers.get(eventType);
    if (!set) {
      set = new Set();
      this.handlers.set(eventType, set);
    }
    set.add(handler);
    return () => {
      const current = this.handlers.get(eventType);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.handlers.delete(eventType);
    };
  }

  /** True when the underlying socket is open and ready to send events. */
  isConnected(): boolean {
    return this.state === "open";
  }

  /** Current connection lifecycle phase. Useful for diagnostics. */
  getState(): RealtimeConnectionState {
    return this.state;
  }

  private awaitOpen(socket: WebSocketLike): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", (ev) =>
        reject(toError(ev, "WebSocket error before open")),
      );
    });
  }

  private attachLifecycleHandlers(socket: WebSocketLike): void {
    socket.addEventListener("message", (ev) => {
      const event = parseEvent(ev.data);
      if (event) this.dispatch(event);
    });
    socket.addEventListener("close", () => {
      this.state = "closed";
      this.socket = null;
    });
  }

  private dispatch(event: RealtimeEvent): void {
    const typed = this.handlers.get(event.type);
    if (typed) for (const h of typed) h(event);
    const wild = this.handlers.get(REALTIME_WILDCARD_EVENT);
    if (wild) for (const h of wild) h(event);
  }

  private requireOpen(): void {
    if (this.state !== "open" || !this.socket) {
      throw new Error("RealtimeClient is not connected.");
    }
  }
}
