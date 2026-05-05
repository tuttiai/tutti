/**
 * Public types for `@tuttiai/realtime` — a thin client over the
 * OpenAI Realtime API WebSocket protocol.
 *
 * The shapes here mirror the wire format documented at
 * `https://platform.openai.com/docs/guides/realtime` and are intentionally
 * permissive: only the fields the {@link RealtimeClient} reads are typed,
 * the rest passes through opaquely as `unknown` so future server-side
 * fields don't break the client.
 */

/** Synthesised voice names the Realtime API accepts. */
export type RealtimeVoiceName =
  | "alloy"
  | "echo"
  | "shimmer"
  | "ash"
  | "coral"
  | "sage";

/**
 * Server-side voice activity detection settings. The Realtime API
 * currently only exposes `server_vad`; the discriminator is kept so
 * future modes can be added without breaking the union.
 */
export interface ServerVadConfig {
  type: "server_vad";
  /** Activation probability threshold, 0–1. Defaults to `0.5` server-side. */
  threshold?: number;
  /** Silence in milliseconds before the server commits a turn. Defaults to `500`. */
  silenceDurationMs?: number;
}

/** Configuration accepted by {@link RealtimeClient.connect}. */
export interface RealtimeConfig {
  /** Realtime model identifier, e.g. `gpt-4o-realtime-preview`. */
  model: string;
  /** Synthesised voice for assistant audio output. */
  voice: RealtimeVoiceName;
  /** Turn-detection strategy. Only `server_vad` is supported today. */
  turnDetection: ServerVadConfig;
  /** System prompt for the realtime session. */
  instructions?: string;
  /** Sampling temperature in the 0–2 range. */
  temperature?: number;
  /** Hard cap on response tokens per assistant turn. */
  maxResponseTokens?: number;
}

/**
 * Envelope for both client- and server-originated Realtime events.
 *
 * The `type` field is the discriminator (e.g. `response.audio.delta`,
 * `input_audio_buffer.append`); all other fields are pass-through and
 * typed as `unknown` so callers narrow at the use site.
 */
export interface RealtimeEvent {
  type: string;
  [key: string]: unknown;
}

/** Subscriber callback registered via {@link RealtimeClient.on}. */
export type RealtimeEventHandler = (event: RealtimeEvent) => void;

/** Wildcard event type — handlers registered with this receive every event. */
export const REALTIME_WILDCARD_EVENT = "*";

/** Connection lifecycle phases reported by {@link RealtimeClient.isConnected}. */
export type RealtimeConnectionState =
  | "idle"
  | "connecting"
  | "open"
  | "closing"
  | "closed";
