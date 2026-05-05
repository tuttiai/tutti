import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { AgentConfig, Tool } from "@tuttiai/types";

import { RealtimeSession } from "../src/session.js";
import type { RealtimeConfig } from "../src/types.js";
import { MockWebSocket } from "./mock-websocket.js";

const config: RealtimeConfig = {
  model: "gpt-4o-realtime-preview",
  voice: "alloy",
  turnDetection: { type: "server_vad" },
};

const agent: AgentConfig = {
  name: "concierge",
  system_prompt: "Be helpful.",
  voices: [],
  permissions: ["network"],
};

function makeEcho(): Tool<{ text: string }> {
  return {
    name: "echo",
    description: "Echo input.",
    parameters: z.object({ text: z.string() }),
    execute: async (input) => ({ content: input.text }),
  };
}

async function open(session: RealtimeSession): Promise<MockWebSocket> {
  const promise = session.connect("test-key");
  const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  if (!socket) throw new Error("expected socket");
  socket.fireOpen();
  await promise;
  return socket;
}

beforeEach(() => MockWebSocket.reset());
afterEach(() => MockWebSocket.reset());

describe("RealtimeSession", () => {
  it("emits 'audio' deltas from response.audio.delta server events", async () => {
    const session = new RealtimeSession({
      config,
      tools: [makeEcho()],
      agent,
      websocketCtor: MockWebSocket,
    });
    const deltas: string[] = [];
    session.on("audio", (e) => deltas.push(e.delta));

    const socket = await open(session);
    socket.fireMessage(JSON.stringify({ type: "response.audio.delta", delta: "abc" }));
    socket.fireMessage(JSON.stringify({ type: "response.audio.delta", delta: "def" }));

    expect(deltas).toEqual(["abc", "def"]);
    session.close();
  });

  it("emits 'text' deltas and assistant 'transcript' deltas", async () => {
    const session = new RealtimeSession({
      config,
      tools: [makeEcho()],
      agent,
      websocketCtor: MockWebSocket,
    });
    const text: string[] = [];
    const transcript: Array<{ text: string; role: string }> = [];
    session.on("text", (e) => text.push(e.delta));
    session.on("transcript", (e) => transcript.push(e));

    const socket = await open(session);
    socket.fireMessage(JSON.stringify({ type: "response.text.delta", delta: "hi" }));
    socket.fireMessage(JSON.stringify({ type: "response.audio_transcript.delta", delta: "world" }));
    socket.fireMessage(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "the user said this",
      }),
    );

    expect(text).toEqual(["hi"]);
    expect(transcript).toEqual([
      { text: "world", role: "assistant" },
      { text: "the user said this", role: "user" },
    ]);
    session.close();
  });

  it("emits 'tool:call' and 'tool:result' across a function call round-trip", async () => {
    const session = new RealtimeSession({
      config,
      tools: [makeEcho()],
      agent,
      websocketCtor: MockWebSocket,
    });
    const calls: unknown[] = [];
    const results: unknown[] = [];
    session.on("tool:call", (e) => calls.push(e));
    session.on("tool:result", (e) => results.push(e));

    const socket = await open(session);
    socket.fireMessage(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: "c1",
        name: "echo",
        arguments: JSON.stringify({ text: "hi" }),
      }),
    );
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));

    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
    session.close();
  });

  it("emits 'error' when the server delivers an error event", async () => {
    const session = new RealtimeSession({
      config,
      tools: [makeEcho()],
      agent,
      websocketCtor: MockWebSocket,
    });
    const errors: Error[] = [];
    session.on("error", (e) => errors.push(e.error));

    const socket = await open(session);
    socket.fireMessage(JSON.stringify({ type: "error", message: "bad request" }));

    expect(errors[0]?.message).toBe("bad request");
    session.close();
  });

  it("emits 'end' on response.done and on close()", async () => {
    const session = new RealtimeSession({
      config,
      tools: [makeEcho()],
      agent,
      websocketCtor: MockWebSocket,
    });
    const reasons: string[] = [];
    session.on("end", (e) => reasons.push(e.reason));

    const socket = await open(session);
    socket.fireMessage(JSON.stringify({ type: "response.done" }));
    session.close();

    expect(reasons).toEqual(["response.done", "close"]);
  });

  it("close() before connect is a no-op", () => {
    const session = new RealtimeSession({
      config,
      tools: [makeEcho()],
      agent,
      websocketCtor: MockWebSocket,
    });
    expect(() => session.close()).not.toThrow();
  });

  it("on() returns an unsubscribe fn", async () => {
    const session = new RealtimeSession({
      config,
      tools: [makeEcho()],
      agent,
      websocketCtor: MockWebSocket,
    });
    const seen: string[] = [];
    const off = session.on("text", (e) => seen.push(e.delta));

    const socket = await open(session);
    socket.fireMessage(JSON.stringify({ type: "response.text.delta", delta: "a" }));
    off();
    socket.fireMessage(JSON.stringify({ type: "response.text.delta", delta: "b" }));

    expect(seen).toEqual(["a"]);
    session.close();
  });

  it("resolveInterrupt before connect throws", () => {
    const session = new RealtimeSession({
      config,
      tools: [makeEcho()],
      agent,
      websocketCtor: MockWebSocket,
    });
    expect(() => session.resolveInterrupt("any", "approved")).toThrow(/not connected/i);
  });
});
