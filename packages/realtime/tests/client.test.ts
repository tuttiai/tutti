import { Buffer } from "node:buffer";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RealtimeClient } from "../src/client.js";
import type { RealtimeConfig } from "../src/types.js";
import { MockWebSocket } from "./mock-websocket.js";

const baseConfig: RealtimeConfig = {
  model: "gpt-4o-realtime-preview",
  voice: "alloy",
  turnDetection: { type: "server_vad" },
};

function newClient(): RealtimeClient {
  return new RealtimeClient({ websocketCtor: MockWebSocket });
}

async function connectClient(
  client: RealtimeClient,
  config: RealtimeConfig = baseConfig,
): Promise<MockWebSocket> {
  const promise = client.connect("test-key", config);
  // The constructor pushes synchronously; the most recent instance is ours.
  const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  if (!socket) throw new Error("MockWebSocket was not constructed");
  socket.fireOpen();
  await promise;
  return socket;
}

beforeEach(() => {
  MockWebSocket.reset();
});

afterEach(() => {
  MockWebSocket.reset();
});

describe("RealtimeClient", () => {
  describe("connection state", () => {
    it("starts in 'idle' and is not connected", () => {
      const client = newClient();
      expect(client.getState()).toBe("idle");
      expect(client.isConnected()).toBe(false);
    });

    it("transitions idle → connecting → open during connect", async () => {
      const client = newClient();
      const promise = client.connect("test-key", baseConfig);
      expect(client.getState()).toBe("connecting");
      expect(client.isConnected()).toBe(false);

      const socket = MockWebSocket.instances[0];
      if (!socket) throw new Error("expected socket");
      socket.fireOpen();
      await promise;

      expect(client.getState()).toBe("open");
      expect(client.isConnected()).toBe(true);
    });

    it("encodes the model into the URL and forwards auth via subprotocol", async () => {
      const client = newClient();
      const socket = await connectClient(client);

      expect(socket.url).toBe(
        "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
      );
      expect(socket.protocols).toEqual([
        "realtime",
        "openai-insecure-api-key.test-key",
        "openai-beta.realtime-v1",
      ]);
    });

    it("sends a session.update with the supplied config after open", async () => {
      const client = newClient();
      const socket = await connectClient(client, {
        model: "gpt-4o-realtime-preview",
        voice: "sage",
        turnDetection: {
          type: "server_vad",
          threshold: 0.6,
          silenceDurationMs: 250,
        },
        instructions: "Be concise.",
        temperature: 0.4,
        maxResponseTokens: 128,
      });

      expect(socket.sent).toHaveLength(1);
      const sent = socket.sent[0];
      if (sent === undefined) throw new Error("expected one sent frame");
      expect(JSON.parse(sent)).toEqual({
        type: "session.update",
        session: {
          voice: "sage",
          turn_detection: {
            type: "server_vad",
            threshold: 0.6,
            silence_duration_ms: 250,
          },
          instructions: "Be concise.",
          temperature: 0.4,
          max_response_output_tokens: 128,
        },
      });
    });

    it("rejects connect() if the socket errors before opening", async () => {
      const client = newClient();
      const promise = client.connect("test-key", baseConfig);
      const socket = MockWebSocket.instances[0];
      if (!socket) throw new Error("expected socket");
      socket.fireError(new Error("handshake failed"));

      await expect(promise).rejects.toThrow("handshake failed");
      expect(client.getState()).toBe("closed");
      expect(client.isConnected()).toBe(false);
    });

    it("rejects connect() while already connecting or open", async () => {
      const client = newClient();
      const first = client.connect("test-key", baseConfig);
      await expect(client.connect("test-key", baseConfig)).rejects.toThrow(
        /already|state/i,
      );
      const socket = MockWebSocket.instances[0];
      if (!socket) throw new Error("expected socket");
      socket.fireOpen();
      await first;
      await expect(client.connect("test-key", baseConfig)).rejects.toThrow(
        /already|state/i,
      );
    });

    it("disconnect() closes the socket and reports 'closed'", async () => {
      const client = newClient();
      const socket = await connectClient(client);
      client.disconnect();
      expect(client.getState()).toBe("closed");
      expect(client.isConnected()).toBe(false);
      expect(socket.readyState).toBe(3);
    });

    it("disconnect() before connect is a safe no-op", () => {
      const client = newClient();
      client.disconnect();
      expect(client.getState()).toBe("closed");
      expect(MockWebSocket.instances).toHaveLength(0);
    });

    it("server-side close transitions state back to 'closed'", async () => {
      const client = newClient();
      const socket = await connectClient(client);
      socket.fireClose({ code: 1000 });
      expect(client.getState()).toBe("closed");
      expect(client.isConnected()).toBe(false);
    });

    it("can reconnect after a previous disconnect", async () => {
      const client = newClient();
      await connectClient(client);
      client.disconnect();
      const second = await connectClient(client);
      expect(client.isConnected()).toBe(true);
      expect(second).toBe(MockWebSocket.instances[1]);
    });

    it("send methods throw when not connected", () => {
      const client = newClient();
      expect(() => client.sendText("hi")).toThrow(/not connected/i);
      expect(() => client.commitAudio()).toThrow(/not connected/i);
      expect(() => client.sendAudio(Buffer.from([0, 1]))).toThrow(/not connected/i);
    });
  });

  describe("event subscription", () => {
    it("dispatches inbound events to type-specific subscribers", async () => {
      const client = newClient();
      const socket = await connectClient(client);
      const calls: unknown[] = [];
      client.on("response.audio.delta", (e) => calls.push(e));

      socket.fireMessage(
        JSON.stringify({ type: "response.audio.delta", delta: "abc" }),
      );

      expect(calls).toEqual([{ type: "response.audio.delta", delta: "abc" }]);
    });

    it("does not dispatch events of other types to a subscriber", async () => {
      const client = newClient();
      const socket = await connectClient(client);
      const calls: unknown[] = [];
      client.on("response.audio.delta", (e) => calls.push(e));

      socket.fireMessage(JSON.stringify({ type: "session.updated" }));
      expect(calls).toHaveLength(0);
    });

    it("delivers each event to every subscriber for that type", async () => {
      const client = newClient();
      const socket = await connectClient(client);
      const a: unknown[] = [];
      const b: unknown[] = [];
      client.on("session.updated", (e) => a.push(e));
      client.on("session.updated", (e) => b.push(e));

      socket.fireMessage(JSON.stringify({ type: "session.updated" }));

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });

    it("delivers every event to wildcard subscribers", async () => {
      const client = newClient();
      const socket = await connectClient(client);
      const seen: string[] = [];
      client.on("*", (e) => seen.push(e.type));

      socket.fireMessage(JSON.stringify({ type: "session.updated" }));
      socket.fireMessage(JSON.stringify({ type: "response.audio.delta" }));

      expect(seen).toEqual(["session.updated", "response.audio.delta"]);
    });

    it("on() returns an unsubscribe function that stops further delivery", async () => {
      const client = newClient();
      const socket = await connectClient(client);
      const calls: unknown[] = [];
      const off = client.on("session.updated", (e) => calls.push(e));

      socket.fireMessage(JSON.stringify({ type: "session.updated" }));
      off();
      socket.fireMessage(JSON.stringify({ type: "session.updated" }));

      expect(calls).toHaveLength(1);
    });

    it("calling the unsubscribe function twice is a no-op", async () => {
      const client = newClient();
      const socket = await connectClient(client);
      const calls: unknown[] = [];
      const off = client.on("session.updated", (e) => calls.push(e));

      off();
      off();
      socket.fireMessage(JSON.stringify({ type: "session.updated" }));
      expect(calls).toHaveLength(0);
    });

    it("unsubscribing one handler does not affect siblings", async () => {
      const client = newClient();
      const socket = await connectClient(client);
      const a: unknown[] = [];
      const b: unknown[] = [];
      const offA = client.on("session.updated", (e) => a.push(e));
      client.on("session.updated", (e) => b.push(e));

      offA();
      socket.fireMessage(JSON.stringify({ type: "session.updated" }));

      expect(a).toHaveLength(0);
      expect(b).toHaveLength(1);
    });

    it("ignores malformed inbound frames without crashing", async () => {
      const client = newClient();
      const socket = await connectClient(client);
      const seen: unknown[] = [];
      client.on("*", (e) => seen.push(e));

      socket.fireMessage("not json");
      socket.fireMessage(JSON.stringify({ no: "type" }));
      socket.fireMessage(new ArrayBuffer(8));
      socket.fireMessage(JSON.stringify({ type: "ok" }));

      expect(seen).toEqual([{ type: "ok" }]);
    });
  });

  describe("outbound events", () => {
    it("sendText emits a conversation.item.create with input_text content", async () => {
      const client = newClient();
      const socket = await connectClient(client);
      socket.sent.length = 0; // drop the initial session.update

      client.sendText("hello");

      expect(socket.sent).toHaveLength(1);
      const sent = socket.sent[0];
      if (sent === undefined) throw new Error("expected one sent frame");
      expect(JSON.parse(sent)).toEqual({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      });
    });

    it("sendAudio base64-encodes the PCM buffer in input_audio_buffer.append", async () => {
      const client = newClient();
      const socket = await connectClient(client);
      socket.sent.length = 0;

      const buf = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      client.sendAudio(buf);

      const sent = socket.sent[0];
      if (sent === undefined) throw new Error("expected one sent frame");
      expect(JSON.parse(sent)).toEqual({
        type: "input_audio_buffer.append",
        audio: buf.toString("base64"),
      });
    });

    it("commitAudio emits input_audio_buffer.commit", async () => {
      const client = newClient();
      const socket = await connectClient(client);
      socket.sent.length = 0;

      client.commitAudio();

      const sent = socket.sent[0];
      if (sent === undefined) throw new Error("expected one sent frame");
      expect(JSON.parse(sent)).toEqual({ type: "input_audio_buffer.commit" });
    });
  });
});
