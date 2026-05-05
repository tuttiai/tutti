# @tuttiai/realtime

Thin client over the [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime) WebSocket protocol, used by [Tutti](https://tutti-ai.com) voice agents.

```bash
npm install @tuttiai/realtime
```

The package has no runtime dependencies. It uses the standard `WebSocket` constructor available on Node ≥ 22 and in modern browsers; pass `websocketCtor` to `new RealtimeClient(...)` if you need to inject a polyfill.

## Quick start

```typescript
import { RealtimeClient } from "@tuttiai/realtime";

const client = new RealtimeClient();

const off = client.on("response.audio.delta", (event) => {
  // event.delta is a base64-encoded PCM chunk
  speaker.play(event["delta"]);
});

await client.connect(process.env.OPENAI_API_KEY!, {
  model: "gpt-4o-realtime-preview",
  voice: "alloy",
  turnDetection: { type: "server_vad", threshold: 0.5, silenceDurationMs: 500 },
  instructions: "You are a concise assistant.",
});

client.sendText("Hi there!");

// Stream microphone audio (16-bit PCM):
client.sendAudio(pcm16Chunk);
client.commitAudio(); // optional when relying on server VAD

off();
client.disconnect();
```

## API

| Member | Purpose |
|---|---|
| `connect(apiKey, config)` | Open a WebSocket and forward `session.update`. |
| `disconnect()` | Close the socket. Safe to call from any state. |
| `sendAudio(pcm16Buffer)` | Append a chunk to `input_audio_buffer.append`. |
| `commitAudio()` | Mark end-of-utterance via `input_audio_buffer.commit`. |
| `sendText(text)` | Insert a user message via `conversation.item.create`. |
| `on(eventType, handler)` | Subscribe; returns an unsubscribe function. Pass `'*'` for all events. |
| `isConnected()` | `true` only when the socket is `open`. |
| `getState()` | Current lifecycle phase: `idle`, `connecting`, `open`, `closing`, `closed`. |

## Authentication

The Realtime API accepts the API key as a WebSocket subprotocol token:
`openai-insecure-api-key.<key>`. This is the only auth path that works
without custom upgrade headers (browsers, Node global `WebSocket`).
Treat the API key as you would any other browser-visible secret — gate
it through your own backend in production.
