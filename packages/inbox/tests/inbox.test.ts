import { describe, expect, it, vi } from "vitest";
import { EventBus } from "@tuttiai/core";
import type { TuttiEvent, AgentResult } from "@tuttiai/types";
import { TuttiInbox } from "../src/inbox.js";
import type { InboxAdapter, InboxMessage, InboxMessageHandler, InboxReply } from "../src/types.js";
import type { TuttiRuntime } from "@tuttiai/core";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class MockAdapter implements InboxAdapter {
  readonly platform: "telegram" = "telegram";
  handler?: InboxMessageHandler;
  send = vi.fn(async (_chatId: string, _reply: InboxReply): Promise<void> => {});
  stop = vi.fn(async (): Promise<void> => {});
  start = vi.fn(async (h: InboxMessageHandler): Promise<void> => {
    this.handler = h;
  });

  /** Emit an inbound message as if it had arrived from the platform. */
  async receive(msg: Partial<InboxMessage> & { text?: string }): Promise<void> {
    if (!this.handler) throw new Error("MockAdapter.start was not awaited");
    const full: InboxMessage = {
      platform: "telegram",
      platform_user_id: msg.platform_user_id ?? "user-1",
      platform_chat_id: msg.platform_chat_id ?? "chat-1",
      text: msg.text ?? "hello",
      timestamp: msg.timestamp ?? Date.now(),
      raw: msg.raw ?? {},
    };
    await this.handler(full);
  }
}

interface RuntimeStub {
  events: EventBus;
  run: ReturnType<typeof vi.fn>;
}

function makeRuntime(opts: {
  outputs?: string[];
  errors?: Array<Error | undefined>;
} = {}): { runtime: TuttiRuntime; events: EventBus; mock: RuntimeStub } {
  const events = new EventBus();
  let call = 0;
  const run = vi.fn(
    async (
      _agent: string,
      input: string,
      session_id?: string,
    ): Promise<AgentResult> => {
      const idx = call++;
      const err = opts.errors?.[idx];
      if (err) throw err;
      const out = opts.outputs?.[idx] ?? `reply to: ${input}`;
      return {
        session_id: session_id ?? `sess-${idx + 1}`,
        output: out,
        messages: [],
        turns: 1,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    },
  );
  const stub: RuntimeStub = { events, run };
  return { runtime: stub as unknown as TuttiRuntime, events, mock: stub };
}

/** Capture all events of any type. */
function captureEvents(events: EventBus): TuttiEvent[] {
  const captured: TuttiEvent[] = [];
  events.onAny((e) => captured.push(e));
  return captured;
}

async function flush(times: number = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------
// Construction guards
// ---------------------------------------------------------------------------

describe("TuttiInbox — construction", () => {
  it("rejects empty agent", () => {
    const { runtime } = makeRuntime();
    expect(
      () => new TuttiInbox(runtime, { agent: "", adapters: [new MockAdapter()] }),
    ).toThrow(/agent/);
  });

  it("rejects empty adapters", () => {
    const { runtime } = makeRuntime();
    expect(() => new TuttiInbox(runtime, { agent: "support", adapters: [] })).toThrow(
      /at least one adapter/,
    );
  });

  it("rejects two adapters with the same platform", () => {
    const { runtime } = makeRuntime();
    expect(
      () =>
        new TuttiInbox(runtime, {
          agent: "support",
          adapters: [new MockAdapter(), new MockAdapter()],
        }),
    ).toThrow(/duplicate adapter/);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("TuttiInbox — lifecycle", () => {
  it("start() registers a handler with each adapter", async () => {
    const { runtime } = makeRuntime();
    const adapter = new MockAdapter();
    const inbox = new TuttiInbox(runtime, { agent: "support", adapters: [adapter] });
    await inbox.start();
    expect(adapter.start).toHaveBeenCalledTimes(1);
    expect(adapter.handler).toBeDefined();
  });

  it("start() is idempotent", async () => {
    const { runtime } = makeRuntime();
    const adapter = new MockAdapter();
    const inbox = new TuttiInbox(runtime, { agent: "support", adapters: [adapter] });
    await inbox.start();
    await inbox.start();
    expect(adapter.start).toHaveBeenCalledTimes(1);
  });

  it("stop() calls each adapter.stop in parallel and is idempotent", async () => {
    const { runtime } = makeRuntime();
    const adapter = new MockAdapter();
    const inbox = new TuttiInbox(runtime, { agent: "support", adapters: [adapter] });
    await inbox.start();
    await inbox.stop();
    await inbox.stop();
    expect(adapter.stop).toHaveBeenCalledTimes(1);
  });

  it("an adapter.stop() that throws is captured as inbox:error", async () => {
    const { runtime, events } = makeRuntime();
    const adapter = new MockAdapter();
    adapter.stop.mockRejectedValueOnce(new Error("nic-failed"));
    const captured = captureEvents(events);
    const inbox = new TuttiInbox(runtime, { agent: "support", adapters: [adapter] });
    await inbox.start();
    await inbox.stop();
    const err = captured.find((e) => e.type === "inbox:error");
    expect(err).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("TuttiInbox — happy path", () => {
  it("dispatches an inbound message to the agent and ships the reply", async () => {
    const { runtime, events, mock } = makeRuntime({ outputs: ["pong"] });
    const adapter = new MockAdapter();
    const captured = captureEvents(events);
    const inbox = new TuttiInbox(runtime, { agent: "support", adapters: [adapter] });
    await inbox.start();
    await adapter.receive({ text: "ping" });
    await flush();
    expect(mock.run).toHaveBeenCalledWith("support", "ping", undefined);
    expect(adapter.send).toHaveBeenCalledWith("chat-1", { text: "pong" });
    const types = captured.map((e) => e.type);
    expect(types).toContain("inbox:message_received");
    expect(types).toContain("inbox:message_replied");
  });

  it("emits inbox:message_received with text_length, never the text itself", async () => {
    const { runtime, events } = makeRuntime();
    const adapter = new MockAdapter();
    const captured = captureEvents(events);
    const inbox = new TuttiInbox(runtime, { agent: "support", adapters: [adapter] });
    await inbox.start();
    await adapter.receive({ text: "secret message body" });
    await flush();
    const recv = captured.find((e) => e.type === "inbox:message_received");
    expect(recv).toBeDefined();
    if (recv && recv.type === "inbox:message_received") {
      expect(recv.text_length).toBe("secret message body".length);
      // The text itself MUST NOT be present on the event.
      expect(JSON.stringify(recv)).not.toContain("secret message body");
    }
  });

  it("binds the new session id on first message and reuses it on the second", async () => {
    const { runtime, mock } = makeRuntime({ outputs: ["a", "b"] });
    const adapter = new MockAdapter();
    const inbox = new TuttiInbox(runtime, { agent: "support", adapters: [adapter] });
    await inbox.start();
    await adapter.receive({ text: "hi", platform_user_id: "u-1" });
    await flush();
    await adapter.receive({ text: "again", platform_user_id: "u-1" });
    await flush();
    expect(mock.run.mock.calls[0]).toEqual(["support", "hi", undefined]);
    expect(mock.run.mock.calls[1]).toEqual(["support", "again", "sess-1"]);
  });

  it("processes messages from the same chat serially and from different chats concurrently", async () => {
    const { runtime, mock } = makeRuntime();
    let inFlight = 0;
    let maxInFlight = 0;
    mock.run.mockImplementation(async (_a: string, input: string, sid?: string): Promise<AgentResult> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return {
        session_id: sid ?? `sess-${input}`,
        output: `out-${input}`,
        messages: [],
        turns: 1,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    });
    const adapter = new MockAdapter();
    const inbox = new TuttiInbox(runtime, { agent: "support", adapters: [adapter] });
    await inbox.start();
    // Same chat, three messages — should serialise.
    await adapter.receive({ text: "1", platform_chat_id: "c-A" });
    await adapter.receive({ text: "2", platform_chat_id: "c-A" });
    await adapter.receive({ text: "3", platform_chat_id: "c-A" });
    // Different chats — can interleave.
    await adapter.receive({ text: "x", platform_chat_id: "c-B" });
    await adapter.receive({ text: "y", platform_chat_id: "c-C" });
    // Wait long enough for all runs.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(maxInFlight).toBeGreaterThan(1);
    // chat-A messages must have been ordered.
    const aOrder = mock.run.mock.calls
      .filter((call) => /^[123]$/.test(String(call[1])))
      .map((call) => String(call[1]));
    expect(aOrder).toEqual(["1", "2", "3"]);
  });
});

// ---------------------------------------------------------------------------
// Policy: allow-list, rate limit, queue full, empty text
// ---------------------------------------------------------------------------

describe("TuttiInbox — policy", () => {
  it("blocks senders not in allowedUsers and emits the typed event", async () => {
    const { runtime, events, mock } = makeRuntime();
    const adapter = new MockAdapter();
    const captured = captureEvents(events);
    const inbox = new TuttiInbox(runtime, {
      agent: "support",
      adapters: [adapter],
      allowedUsers: { telegram: ["allowed-user"] },
    });
    await inbox.start();
    await adapter.receive({ platform_user_id: "stranger", text: "hi" });
    await flush();
    expect(mock.run).not.toHaveBeenCalled();
    const blocked = captured.find((e) => e.type === "inbox:message_blocked");
    expect(blocked).toBeDefined();
    if (blocked && blocked.type === "inbox:message_blocked") {
      expect(blocked.reason).toBe("not_allowlisted");
    }
  });

  it("allows senders explicitly in allowedUsers", async () => {
    const { runtime, mock } = makeRuntime();
    const adapter = new MockAdapter();
    const inbox = new TuttiInbox(runtime, {
      agent: "support",
      adapters: [adapter],
      allowedUsers: { telegram: ["allowed-user"] },
    });
    await inbox.start();
    await adapter.receive({ platform_user_id: "allowed-user", text: "hi" });
    await flush();
    expect(mock.run).toHaveBeenCalledTimes(1);
  });

  it("rate-limits per platform_user_id", async () => {
    const { runtime, events, mock } = makeRuntime();
    const adapter = new MockAdapter();
    const captured = captureEvents(events);
    const inbox = new TuttiInbox(runtime, {
      agent: "support",
      adapters: [adapter],
      rateLimit: { messagesPerWindow: 30, windowMs: 60_000, burst: 2 },
    });
    await inbox.start();
    await adapter.receive({ platform_user_id: "u-spam", text: "1" });
    await adapter.receive({ platform_user_id: "u-spam", text: "2" });
    await adapter.receive({ platform_user_id: "u-spam", text: "3" });
    await flush();
    const blocked = captured.filter(
      (e) => e.type === "inbox:message_blocked" &&
      e.reason === "rate_limited",
    );
    expect(blocked.length).toBe(1);
    expect(mock.run).toHaveBeenCalledTimes(2);
  });

  it("`disabled: true` rate limit lets every message through", async () => {
    const { runtime, mock } = makeRuntime();
    const adapter = new MockAdapter();
    const inbox = new TuttiInbox(runtime, {
      agent: "support",
      adapters: [adapter],
      rateLimit: { disabled: true },
      // Raise the per-chat queue ceiling so this test isolates the
      // rate-limit toggle — the queue-full path is covered separately.
      maxQueuePerChat: 100,
    });
    await inbox.start();
    for (let i = 0; i < 50; i++) {
      await adapter.receive({ platform_user_id: "u-spam", text: `${i}` });
    }
    await flush(20);
    expect(mock.run).toHaveBeenCalledTimes(50);
  });

  it("emits queue_full when the per-chat queue overflows", async () => {
    let release: () => void = () => {};
    const stuck = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runtime, events, mock } = makeRuntime();
    mock.run.mockImplementation(async (_a: string, input: string, sid?: string): Promise<AgentResult> => {
      await stuck;
      return {
        session_id: sid ?? "sess-x",
        output: input,
        messages: [],
        turns: 1,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    });
    const adapter = new MockAdapter();
    const captured = captureEvents(events);
    const inbox = new TuttiInbox(runtime, {
      agent: "support",
      adapters: [adapter],
      maxQueuePerChat: 2,
      rateLimit: { disabled: true },
    });
    await inbox.start();
    // First in flight + 2 buffered + 1 overflow.
    await adapter.receive({ text: "1" });
    await adapter.receive({ text: "2" });
    await adapter.receive({ text: "3" });
    await adapter.receive({ text: "4" });
    const blocked = captured.filter(
      (e) => e.type === "inbox:message_blocked" && e.reason === "queue_full",
    );
    expect(blocked.length).toBe(1);
    release();
    await flush(10);
  });

  it("drops empty-text messages", async () => {
    const { runtime, events, mock } = makeRuntime();
    const adapter = new MockAdapter();
    const captured = captureEvents(events);
    const inbox = new TuttiInbox(runtime, { agent: "support", adapters: [adapter] });
    await inbox.start();
    await adapter.receive({ text: "" });
    await flush();
    expect(mock.run).not.toHaveBeenCalled();
    const blocked = captured.find(
      (e) => e.type === "inbox:message_blocked" && e.reason === "empty_text",
    );
    expect(blocked).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Errors never crash the inbox
// ---------------------------------------------------------------------------

describe("TuttiInbox — error handling", () => {
  it("emits inbox:error and keeps processing when runtime.run throws", async () => {
    const { runtime, events, mock } = makeRuntime({
      errors: [new Error("LLM blew up")],
      outputs: ["second"],
    });
    const adapter = new MockAdapter();
    const captured = captureEvents(events);
    const inbox = new TuttiInbox(runtime, { agent: "support", adapters: [adapter] });
    await inbox.start();
    await adapter.receive({ text: "first" });
    await flush();
    await adapter.receive({ text: "next" });
    await flush();
    const err = captured.find((e) => e.type === "inbox:error");
    expect(err).toBeDefined();
    expect(mock.run).toHaveBeenCalledTimes(2);
    expect(adapter.send).toHaveBeenCalledTimes(1); // only the second succeeds
  });

  it("calls config.onError and swallows its own throws", async () => {
    const { runtime } = makeRuntime({ errors: [new Error("blew up")] });
    const adapter = new MockAdapter();
    const onError = vi.fn(() => {
      throw new Error("sink also blew up");
    });
    const inbox = new TuttiInbox(runtime, {
      agent: "support",
      adapters: [adapter],
      onError,
    });
    await inbox.start();
    await adapter.receive({ text: "first" });
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("an adapter.send failure emits inbox:error but the inbox keeps running", async () => {
    const { runtime, events, mock } = makeRuntime({ outputs: ["a", "b"] });
    const adapter = new MockAdapter();
    adapter.send.mockRejectedValueOnce(new Error("delivery failed"));
    const captured = captureEvents(events);
    const inbox = new TuttiInbox(runtime, { agent: "support", adapters: [adapter] });
    await inbox.start();
    await adapter.receive({ text: "first" });
    await flush();
    await adapter.receive({ text: "second" });
    await flush();
    expect(mock.run).toHaveBeenCalledTimes(2);
    const err = captured.find((e) => e.type === "inbox:error");
    expect(err).toBeDefined();
  });
});
