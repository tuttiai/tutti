/**
 * `@tuttiai/realtime` — thin client over the OpenAI Realtime API
 * WebSocket protocol, plus a Tutti-shaped tool/security bridge,
 * high-level session wrapper, and voice factory.
 */

export {
  REALTIME_WILDCARD_EVENT,
  type RealtimeConfig,
  type RealtimeConnectionState,
  type RealtimeEvent,
  type RealtimeEventHandler,
  type RealtimeVoiceName,
  type ServerVadConfig,
} from "./types.js";

export {
  REALTIME_URL,
  SUBPROTOCOL_BETA,
  SUBPROTOCOL_PREFIX_API_KEY,
  buildAuthSubprotocols,
  resolveGlobalWebSocket,
  type WebSocketCtor,
  type WebSocketLike,
} from "./transport.js";

export {
  buildSessionUpdate,
  parseEvent,
  toError,
} from "./event-codec.js";

export {
  buildFunctionCallOutput,
  buildResponseCreate,
  buildToolsSessionUpdate,
  parseFunctionCallDone,
  toolToFunctionDefinition,
  type RealtimeFunctionCall,
} from "./function-codec.js";

export { RealtimeClient, type RealtimeClientOptions } from "./client.js";

export {
  registerTools,
  type RealtimeToolBridge,
  type RegisterToolsOptions,
} from "./tool-bridge.js";

export {
  RealtimeSession,
  type RealtimeSessionEventName,
  type RealtimeSessionEvents,
  type RealtimeSessionOptions,
} from "./session.js";

export {
  TranscriptRecorder,
  type RecorderErrorHandler,
  type TranscriptRecorderOptions,
} from "./transcript-recorder.js";

export { getRealtimeTranscript } from "./transcript.js";

export { RealtimeVoice } from "./voice-factory.js";
