import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackClientWrapper } from "@tuttiai/slack";
import type {
  ClientFactory,
  SlackClientLike,
  SlackEventEnvelope,
  SlackEventLike,
  SocketModeClientLike,
  SocketModeFactory,
} from "@tuttiai/slack";
import { SlackInboxAdapter } from "../../src/adapters/slack.js";
import type { InboxMessage } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Mocks — at the wrapper level. We rely on the real SlackClientWrapper but
// feed it fake @slack/web-api and @slack/socket-mode clients via factories.
// ---------------------------------------------------------------------------

interface MockWebClient extends SlackClientLike {
  chat: SlackClientLike["chat"] & { postMessage: ReturnType<typeof vi.fn> };
}

function makeMockWebClient(): MockWebClient {
  return {
    chat: {
      postMessage: vi.fn(async () => ({
        ok: true,
        ts: "1700000001.000200",
        channel: "C1",
      })),
      update: vi.fn(async () => ({ ok: true })),
      delete: vi.fn(async () => ({ ok: true })),
      getPermalink: vi.fn(async () => ({ ok: true })),
    },
    reactions: { add: vi.fn(async () => ({ ok: true })) },
    conversations: {
      history: vi.fn(async () => ({ ok: true, messages: [] })),
      list: vi.fn(async () => ({ ok: true, channels: [] })),
      info: vi.fn(async () => ({ ok: true })),
      open: vi.fn(async () => ({ ok: true })),
    },
    users: {
      list: vi.fn(async () => ({ ok: true, members: [] })),
      info: vi.fn(async () => ({ ok: true })),
    },
    team: { info: vi.fn(async () => ({ ok: true })) },
  } as unknown as MockWebClient;
}

interface MockSocket extends SocketModeClientLike {
  on: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  emit: (envelope: SlackEventEnvelope) => Promise<void>;
}

function makeMockSocket(): MockSocket {
  let listener:
    | ((env: SlackEventEnvelope) => void | Promise<void>)
    | undefined;
  return {
    on: vi.fn(
      (event: "slack_event", l: (env: SlackEventEnvelope) => void | Promise<void>) => {
        if (event === "slack_event") listener = l;
      },
    ) as unknown as MockSocket["on"],
    start: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    emit: async (env) => {
      if (!listener) throw new Error("no slack_event handler");
      await listener(env);
    },
  };
}

function makeEnvelope(event: Partial<SlackEventLike>): SlackEventEnvelope {
  return {
    envelope_id: "env-x",
    body: {
      type: "events_api",
      team_id: "T1",
      event: { type: "message", ts: "1700000000.001", ...event } as SlackEventLike,
    },
    ack: vi.fn(async () => undefined),
  };
}

function makeFactories(client: MockWebClient, socket: MockSocket): {
  clientFactory: ClientFactory;
  socketModeFactory: SocketModeFactory;
} {
  return {
    clientFactory: () => client,
    socketModeFactory: () => socket,
  };
}

beforeEach(() => {
  SlackClientWrapper.cache.clear();
  delete process.env["SLACK_BOT_TOKEN"];
  delete process.env["SLACK_APP_TOKEN"];
});

afterEach(() => {
  SlackClientWrapper.cache.clear();
});

describe("SlackInboxAdapter", () => {
  it("throws when SLACK_BOT_TOKEN is missing", async () => {
    const adapter = new SlackInboxAdapter({ appToken: "xapp-A" });
    await expect(adapter.start(async () => {})).rejects.toThrow(/SLACK_BOT_TOKEN/);
  });

  it("throws when SLACK_APP_TOKEN is missing", async () => {
    const adapter = new SlackInboxAdapter({ botToken: "xoxb-B" });
    await expect(adapter.start(async () => {})).rejects.toThrow(/SLACK_APP_TOKEN/);
  });

  it("opens the socket on start() and routes inbound messages to the handler", async () => {
    const client = makeMockWebClient();
    const socket = makeMockSocket();
    const { clientFactory, socketModeFactory } = makeFactories(client, socket);
    const adapter = new SlackInboxAdapter({
      botToken: "xoxb-route",
      appToken: "xapp-route",
      clientFactory,
      socketModeFactory,
    });
    const received: InboxMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });
    expect(socket.start).toHaveBeenCalledTimes(1);

    await socket.emit(
      makeEnvelope({ user: "U1", channel: "C1", text: "hello", ts: "1700000000.500" }),
    );
    expect(received.length).toBe(1);
    expect(received[0]).toEqual(
      expect.objectContaining({
        platform: "slack",
        platform_user_id: "U1",
        platform_chat_id: "C1",
        text: "hello",
        timestamp: 1_700_000_000_500,
      }),
    );
  });

  it("filters out bot_id messages (loop guard, delegated to the wrapper)", async () => {
    const client = makeMockWebClient();
    const socket = makeMockSocket();
    const { clientFactory, socketModeFactory } = makeFactories(client, socket);
    const adapter = new SlackInboxAdapter({
      botToken: "xoxb-loop",
      appToken: "xapp-loop",
      clientFactory,
      socketModeFactory,
    });
    const received: InboxMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });
    await socket.emit(makeEnvelope({ bot_id: "B1", channel: "C1", text: "loop" }));
    expect(received).toEqual([]);
  });

  it("send() posts via chat.postMessage with the channel id", async () => {
    const client = makeMockWebClient();
    const socket = makeMockSocket();
    const { clientFactory, socketModeFactory } = makeFactories(client, socket);
    const adapter = new SlackInboxAdapter({
      botToken: "xoxb-send",
      appToken: "xapp-send",
      clientFactory,
      socketModeFactory,
    });
    await adapter.start(async () => {});
    await adapter.send("C1", { text: "pong" });
    expect(client.chat.postMessage).toHaveBeenCalledWith({ channel: "C1", text: "pong" });
  });

  it("send() skips empty replies", async () => {
    const client = makeMockWebClient();
    const socket = makeMockSocket();
    const { clientFactory, socketModeFactory } = makeFactories(client, socket);
    const adapter = new SlackInboxAdapter({
      botToken: "xoxb-empty",
      appToken: "xapp-empty",
      clientFactory,
      socketModeFactory,
    });
    await adapter.start(async () => {});
    await adapter.send("C1", { text: "" });
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("stop() disconnects the socket and releases the wrapper ref", async () => {
    const client = makeMockWebClient();
    const socket = makeMockSocket();
    const { clientFactory, socketModeFactory } = makeFactories(client, socket);
    const adapter = new SlackInboxAdapter({
      botToken: "xoxb-stop",
      appToken: "xapp-stop",
      clientFactory,
      socketModeFactory,
    });
    await adapter.start(async () => {});
    expect(SlackClientWrapper.cache.has("xoxb-stop")).toBe(true);
    await adapter.stop();
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(SlackClientWrapper.cache.has("xoxb-stop")).toBe(false);
  });

  it("start/stop are idempotent", async () => {
    const client = makeMockWebClient();
    const socket = makeMockSocket();
    const { clientFactory, socketModeFactory } = makeFactories(client, socket);
    const adapter = new SlackInboxAdapter({
      botToken: "xoxb-idem",
      appToken: "xapp-idem",
      clientFactory,
      socketModeFactory,
    });
    await adapter.start(async () => {});
    await adapter.start(async () => {});
    await adapter.stop();
    await adapter.stop();
    expect(socket.start).toHaveBeenCalledTimes(1);
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });
});
