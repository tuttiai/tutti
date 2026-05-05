import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { MemoryCheckpointStore } from "@tuttiai/core";
import type { AgentConfig, Tool } from "@tuttiai/types";

import { RealtimeSession } from "../src/session.js";
import { getRealtimeTranscript } from "../src/transcript.js";
import { TranscriptRecorder } from "../src/transcript-recorder.js";
import type { RealtimeConfig } from "../src/types.js";
import { MockWebSocket } from "./mock-websocket.js";

const config: RealtimeConfig = {
  model: "gpt-4o-realtime-preview",
  voice: "alloy",
  turnDetection: { type: "server_vad" },
};

const agent: AgentConfig = {
  name: "concierge",
  system_prompt: "be helpful",
  voices: [],
  permissions: ["network"],
};

function makeEcho(): Tool<{ text: string }> {
  return {
    name: "echo",
    description: "echo input",
    parameters: z.object({ text: z.string() }),
    execute: async (input) => ({ content: input.text }),
  };
}

async function open(session: RealtimeSession): Promise<MockWebSocket> {
  const promise = session.connect("test-key");
  const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  if (!socket) throw new Error("expected mock socket");
  socket.fireOpen();
  await promise;
  return socket;
}

async function flush(): Promise<void> {
  // Two microtask drains cover the recorder's chained `.then` plus
  // any nested Promise resolution inside the in-memory store.
  await new Promise<void>((r) => queueMicrotask(r));
  await new Promise<void>((r) => queueMicrotask(r));
}

beforeEach(() => MockWebSocket.reset());
afterEach(() => MockWebSocket.reset());

describe("RealtimeSession transcript persistence", () => {
  it("does not persist when no checkpointStore is configured", async () => {
    const session = new RealtimeSession({
      config,
      tools: [makeEcho()],
      agent,
      session_id: "rt-1",
      websocketCtor: MockWebSocket,
    });
    const socket = await open(session);
    socket.fireMessage(
      JSON.stringify({ type: "response.audio_transcript.delta", delta: "hi" }),
    );
    await flush();
    // No throw, no checkpoint store — passes if nothing else goes wrong.
    session.close();
  });

  it("persists each transcript event as a checkpoint with a monotonic turn", async () => {
    const store = new MemoryCheckpointStore();
    const session = new RealtimeSession({
      config,
      tools: [makeEcho()],
      agent,
      session_id: "rt-2",
      checkpointStore: store,
      websocketCtor: MockWebSocket,
    });
    const socket = await open(session);

    socket.fireMessage(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "hello",
      }),
    );
    await flush();
    socket.fireMessage(
      JSON.stringify({ type: "response.audio_transcript.delta", delta: "hi back" }),
    );
    await flush();

    const list = await store.list("rt-2");
    expect(list).toHaveLength(2);
    expect(list[0]?.turn).toBe(0);
    expect(list[1]?.turn).toBe(1);
    expect(list[0]?.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(list[1]?.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi back" },
    ]);
    session.close();
  });

  it("skips empty transcript deltas", async () => {
    const store = new MemoryCheckpointStore();
    const session = new RealtimeSession({
      config,
      tools: [makeEcho()],
      agent,
      session_id: "rt-3",
      checkpointStore: store,
      websocketCtor: MockWebSocket,
    });
    const socket = await open(session);
    socket.fireMessage(
      JSON.stringify({ type: "response.audio_transcript.delta", delta: "" }),
    );
    await flush();
    expect(await store.list("rt-3")).toHaveLength(0);
    session.close();
  });

  it("emits 'error' when the checkpoint store throws", async () => {
    const store = new MemoryCheckpointStore();
    const broken = {
      ...store,
      save: () => Promise.reject(new Error("boom")),
    };
    const session = new RealtimeSession({
      config,
      tools: [makeEcho()],
      agent,
      session_id: "rt-4",
      checkpointStore: broken as unknown as MemoryCheckpointStore,
      websocketCtor: MockWebSocket,
    });
    const errors: Error[] = [];
    session.on("error", (e) => errors.push(e.error));
    const socket = await open(session);
    socket.fireMessage(
      JSON.stringify({ type: "response.audio_transcript.delta", delta: "hi" }),
    );
    await flush();
    expect(errors[0]?.message).toBe("boom");
    session.close();
  });
});

describe("getRealtimeTranscript", () => {
  it("returns the latest checkpoint's messages array", async () => {
    const store = new MemoryCheckpointStore();
    const recorder = new TranscriptRecorder({ store, session_id: "rt-5" });
    await recorder.record("user", "ping");
    await recorder.record("assistant", "pong");

    const turns = await getRealtimeTranscript("rt-5", store);
    expect(turns).toEqual([
      { role: "user", content: "ping" },
      { role: "assistant", content: "pong" },
    ]);
  });

  it("returns [] for an unknown session id", async () => {
    const store = new MemoryCheckpointStore();
    expect(await getRealtimeTranscript("never-existed", store)).toEqual([]);
  });
});

describe("TranscriptRecorder", () => {
  it("preserves order under concurrent record() calls", async () => {
    const store = new MemoryCheckpointStore();
    const recorder = new TranscriptRecorder({ store, session_id: "rt-6" });
    await Promise.all([
      recorder.record("user", "one"),
      recorder.record("assistant", "two"),
      recorder.record("user", "three"),
    ]);
    const list = await store.list("rt-6");
    expect(list.map((c) => c.turn)).toEqual([0, 1, 2]);
    expect(list[2]?.messages.map((m) => m.content)).toEqual(["one", "two", "three"]);
  });

  it("snapshot() reflects the in-memory transcript", async () => {
    const store = new MemoryCheckpointStore();
    const recorder = new TranscriptRecorder({ store, session_id: "rt-7" });
    await recorder.record("user", "hello");
    expect(recorder.snapshot()).toEqual([{ role: "user", content: "hello" }]);
  });
});
