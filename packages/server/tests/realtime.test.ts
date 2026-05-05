import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { TuttiRuntime } from "@tuttiai/core";
import type { AgentConfig, RealtimeAgentConfig, ScoreConfig } from "@tuttiai/types";

import { createServer } from "../src/index.js";
import { textResponse, createMockProvider, API_KEY } from "./helpers.js";

const REALTIME: RealtimeAgentConfig = {
  model: "gpt-4o-realtime-preview",
  voice: "alloy",
  turnDetection: { type: "server_vad" },
};

interface MockListeners {
  open: Array<() => void>;
  close: Array<(ev: { code?: number; reason?: string }) => void>;
  error: Array<(ev: unknown) => void>;
  message: Array<(ev: { data: unknown }) => void>;
}

/**
 * Stub `globalThis.WebSocket` so the realtime route's `RealtimeClient`
 * constructs this instead of dialling `wss://api.openai.com`. The test
 * captures every constructed instance so it can drive lifecycle events.
 */
class FakeOpenAISocket {
  static instances: FakeOpenAISocket[] = [];
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
    FakeOpenAISocket.instances.push(this);
    queueMicrotask(() => this.fireOpen());
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: keyof MockListeners, listener: (ev: any) => void): void {
    (this.listeners[type] as Array<(ev: unknown) => void>).push(listener);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.readyState = 3;
    for (const l of this.listeners.close) {
      l({ ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) });
    }
  }
  fireOpen(): void {
    this.readyState = 1;
    for (const l of this.listeners.open) l();
  }
  fireMessage(data: unknown): void {
    for (const l of this.listeners.message) l({ data });
  }
  static reset(): void {
    FakeOpenAISocket.instances = [];
  }
}

interface Harness {
  app: Awaited<ReturnType<typeof createServer>>;
  port: number;
}

async function startServer(agentOverrides: Partial<AgentConfig>, openaiKey: string | undefined): Promise<Harness> {
  const provider = createMockProvider([textResponse("unused")]);
  const agent: AgentConfig = {
    name: "concierge",
    model: "test-model",
    system_prompt: "be helpful",
    voices: [],
    permissions: ["network"],
    ...agentOverrides,
  };
  const score: ScoreConfig = { provider, agents: { concierge: agent } };
  const runtime = new TuttiRuntime(score);
  const app = await createServer({
    port: 0,
    host: "127.0.0.1",
    api_key: API_KEY,
    runtime,
    agent_name: "concierge",
    realtime: true,
    score,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("expected server address");
  if (openaiKey === undefined) delete process.env["OPENAI_API_KEY"];
  else process.env["OPENAI_API_KEY"] = openaiKey;
  return { app, port: addr.port };
}

function openClient(port: number, query: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/realtime${query}`);
}

function nextMessage(ws: WebSocket): Promise<{ type?: string;[key: string]: unknown }> {
  return new Promise((resolve, reject) => {
    const onMsg = (data: WebSocket.RawData): void => {
      ws.off("message", onMsg);
      ws.off("close", onClose);
      resolve(JSON.parse(data.toString()));
    };
    const onClose = (code: number, reason: Buffer): void => {
      ws.off("message", onMsg);
      reject(new Error(`closed before message: ${code} ${reason.toString()}`));
    };
    ws.on("message", onMsg);
    ws.on("close", onClose);
  });
}

function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code: number, reason: Buffer) =>
      resolve({ code, reason: reason.toString() }),
    );
  });
}

describe("GET /realtime-demo", () => {
  let app: Awaited<ReturnType<typeof createServer>> | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it("serves the demo HTML page without auth", async () => {
    ({ app } = await startServer({ realtime: REALTIME }, "sk-test"));
    const res = await app.inject({ method: "GET", url: "/realtime-demo" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Tutti Realtime Demo");
    expect(res.body).toContain("/realtime?api_key=");
  });
});

describe("GET /realtime (WebSocket)", () => {
  let originalWs: typeof globalThis.WebSocket | undefined;
  let app: Awaited<ReturnType<typeof createServer>> | undefined;

  beforeEach(() => {
    FakeOpenAISocket.reset();
    originalWs = globalThis.WebSocket as typeof globalThis.WebSocket | undefined;
    // Override the global WebSocket the realtime client uses so it
    // never dials the real OpenAI endpoint during tests.
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeOpenAISocket;
  });

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    if (originalWs === undefined) {
      delete (globalThis as { WebSocket?: unknown }).WebSocket;
    } else {
      (globalThis as { WebSocket?: unknown }).WebSocket = originalWs;
    }
    delete process.env["OPENAI_API_KEY"];
  });

  it("rejects connections without ?api_key=", async () => {
    let port: number;
    ({ app, port } = await startServer({ realtime: REALTIME }, "sk-test"));
    const ws = openClient(port, "");
    const close = await nextClose(ws);
    expect(close.code).toBe(4401);
    expect(close.reason).toBe("unauthorized");
  });

  it("rejects connections with the wrong api_key", async () => {
    let port: number;
    ({ app, port } = await startServer({ realtime: REALTIME }, "sk-test"));
    const ws = openClient(port, "?api_key=bogus");
    const close = await nextClose(ws);
    expect(close.code).toBe(4401);
  });

  it("rejects when the agent has no realtime config", async () => {
    let port: number;
    ({ app, port } = await startServer({}, "sk-test"));
    const ws = openClient(port, `?api_key=${API_KEY}`);
    const close = await nextClose(ws);
    expect(close.code).toBe(4404);
    expect(close.reason).toBe("realtime_disabled_for_agent");
  });

  it("rejects when realtime is explicitly false on the agent", async () => {
    let port: number;
    ({ app, port } = await startServer({ realtime: false }, "sk-test"));
    const ws = openClient(port, `?api_key=${API_KEY}`);
    const close = await nextClose(ws);
    expect(close.code).toBe(4404);
  });

  it("rejects when OPENAI_API_KEY is not set", async () => {
    let port: number;
    ({ app, port } = await startServer({ realtime: REALTIME }, undefined));
    const ws = openClient(port, `?api_key=${API_KEY}`);
    const close = await nextClose(ws);
    expect(close.code).toBe(4500);
    expect(close.reason).toBe("missing_openai_api_key");
  });

  it("emits a ready frame after a successful realtime handshake", async () => {
    let port: number;
    ({ app, port } = await startServer({ realtime: REALTIME }, "sk-test"));
    const ws = openClient(port, `?api_key=${API_KEY}`);
    const ready = await nextMessage(ws);
    expect(ready.type).toBe("ready");
    expect(ready["model"]).toBe(REALTIME.model);
    expect(ready["voice"]).toBe(REALTIME.voice);
    ws.close();
  });

  it("forwards an inbound text frame as conversation.item.create on the OpenAI socket", async () => {
    let port: number;
    ({ app, port } = await startServer({ realtime: REALTIME }, "sk-test"));
    const ws = openClient(port, `?api_key=${API_KEY}`);
    await nextMessage(ws); // drain the ready frame.
    ws.send(JSON.stringify({ type: "text", content: "hello there" }));
    // Allow the message to traverse the bridge.
    await new Promise<void>((r) => setTimeout(r, 25));

    const upstream = FakeOpenAISocket.instances[0];
    if (!upstream) throw new Error("expected upstream socket");
    const sentText = upstream.sent.map((s) => JSON.parse(s));
    const created = sentText.find(
      (e: { type: string }) => e.type === "conversation.item.create",
    ) as { item: { content: Array<{ text?: string }> } } | undefined;
    expect(created?.item.content[0]?.text).toBe("hello there");
    ws.close();
  });

  it("forwards an inbound audio frame as input_audio_buffer.append (base64 round-trip)", async () => {
    let port: number;
    ({ app, port } = await startServer({ realtime: REALTIME }, "sk-test"));
    const ws = openClient(port, `?api_key=${API_KEY}`);
    await nextMessage(ws);
    const pcm = Buffer.from([0, 1, 2, 3, 4, 5]);
    ws.send(JSON.stringify({ type: "audio", data: pcm.toString("base64") }));
    await new Promise<void>((r) => setTimeout(r, 25));
    const upstream = FakeOpenAISocket.instances[0];
    if (!upstream) throw new Error("expected upstream socket");
    const append = upstream.sent
      .map((s) => JSON.parse(s) as { type: string; audio?: string })
      .find((e) => e.type === "input_audio_buffer.append");
    expect(append?.audio).toBe(pcm.toString("base64"));
    ws.close();
  });

  it("forwards an OpenAI audio delta as an outbound 'audio' frame to the browser", async () => {
    let port: number;
    ({ app, port } = await startServer({ realtime: REALTIME }, "sk-test"));
    const ws = openClient(port, `?api_key=${API_KEY}`);
    await nextMessage(ws);

    const upstream = FakeOpenAISocket.instances[0];
    if (!upstream) throw new Error("expected upstream socket");
    upstream.fireMessage(
      JSON.stringify({ type: "response.audio.delta", delta: "AQID" }),
    );
    const audio = await nextMessage(ws);
    expect(audio.type).toBe("audio");
    expect(audio["data"]).toBe("AQID");
    ws.close();
  });

  it("forwards an OpenAI transcript event as an outbound 'transcript' frame", async () => {
    let port: number;
    ({ app, port } = await startServer({ realtime: REALTIME }, "sk-test"));
    const ws = openClient(port, `?api_key=${API_KEY}`);
    await nextMessage(ws);

    const upstream = FakeOpenAISocket.instances[0];
    if (!upstream) throw new Error("expected upstream socket");
    upstream.fireMessage(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "user said this",
      }),
    );
    const t = await nextMessage(ws);
    expect(t.type).toBe("transcript");
    expect(t["role"]).toBe("user");
    expect(t["text"]).toBe("user said this");
    ws.close();
  });

  it("returns an error frame on a malformed JSON inbound payload", async () => {
    let port: number;
    ({ app, port } = await startServer({ realtime: REALTIME }, "sk-test"));
    const ws = openClient(port, `?api_key=${API_KEY}`);
    await nextMessage(ws);
    ws.send("not-json");
    const err = await nextMessage(ws);
    expect(err.type).toBe("error");
    expect(err["message"]).toMatch(/Malformed/);
    ws.close();
  });
});
