import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordClientWrapper } from "@tuttiai/discord";
import type {
  ClientFactory,
  DiscordClientLike,
  DiscordMessageLike,
  DiscordTextChannelLike,
} from "@tuttiai/discord";
import { DiscordInboxAdapter } from "../../src/adapters/discord.js";
import type { InboxMessage } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Mocks — at the wrapper / discord.js Client level, not the @tuttiai/discord
// module level. We rely on the real DiscordClientWrapper but feed it a fake
// Client via the factory hook.
// ---------------------------------------------------------------------------

interface MockChannel extends DiscordTextChannelLike {
  send: ReturnType<typeof vi.fn>;
}

interface MockClient extends DiscordClientLike {
  on: ReturnType<typeof vi.fn>;
  login: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  channels: { fetch: ReturnType<typeof vi.fn> };
  emitMessage: (msg: DiscordMessageLike) => Promise<void>;
}

function makeChannel(id: string = "C42"): MockChannel {
  return {
    id,
    name: "general",
    guildId: null,
    send: vi.fn(async () => ({})),
    messages: { fetch: vi.fn() } as unknown as MockChannel["messages"],
  };
}

function makeMockClient(channel: MockChannel = makeChannel()): MockClient {
  let listener: ((m: DiscordMessageLike) => void | Promise<void>) | undefined;
  return {
    channels: {
      fetch: vi.fn(async (id: string) => (id === channel.id ? channel : null)),
    },
    guilds: { fetch: vi.fn() },
    users: { fetch: vi.fn() },
    destroy: vi.fn(async () => undefined),
    login: vi.fn(async () => "ok"),
    on: vi.fn((event: "messageCreate", l: (m: DiscordMessageLike) => void | Promise<void>) => {
      if (event === "messageCreate") listener = l;
    }) as unknown as MockClient["on"],
    emitMessage: async (msg) => {
      if (!listener) throw new Error("no messageCreate handler");
      await listener(msg);
    },
  };
}

function makeMessage(overrides: Partial<DiscordMessageLike> = {}): DiscordMessageLike {
  return {
    id: overrides.id ?? "m1",
    channelId: overrides.channelId ?? "C42",
    guildId: overrides.guildId ?? null,
    content: overrides.content ?? "hello inbox",
    createdTimestamp: overrides.createdTimestamp ?? 1_700_000_000_000,
    editedTimestamp: overrides.editedTimestamp ?? null,
    author: {
      id: overrides.author?.id ?? "U7",
      username: overrides.author?.username ?? "alice",
      bot: overrides.author?.bot ?? false,
    },
    edit: vi.fn(),
    delete: vi.fn(),
    react: vi.fn(),
  } as DiscordMessageLike;
}

function makeFactory(client: MockClient): ClientFactory {
  return () => client;
}

beforeEach(() => {
  DiscordClientWrapper.cache.clear();
  delete process.env["DISCORD_BOT_TOKEN"];
});

afterEach(() => {
  DiscordClientWrapper.cache.clear();
});

describe("DiscordInboxAdapter", () => {
  it("throws when no token is configured at start()", async () => {
    const adapter = new DiscordInboxAdapter();
    await expect(adapter.start(async () => {})).rejects.toThrow(/DISCORD_BOT_TOKEN/);
  });

  it("subscribes to messageCreate and routes inbound messages to the handler", async () => {
    const channel = makeChannel("C42");
    const client = makeMockClient(channel);
    const adapter = new DiscordInboxAdapter({
      token: "tok-1",
      clientFactory: makeFactory(client),
    });
    const received: InboxMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });
    expect(client.login).toHaveBeenCalledTimes(1);
    expect(client.on).toHaveBeenCalledWith("messageCreate", expect.any(Function));

    await client.emitMessage(makeMessage({ id: "m1", content: "hello" }));
    expect(received.length).toBe(1);
    expect(received[0]).toEqual(
      expect.objectContaining({
        platform: "discord",
        platform_user_id: "U7",
        platform_chat_id: "C42",
        text: "hello",
        timestamp: 1_700_000_000_000,
      }),
    );
  });

  it("filters out bot messages (delegated to the wrapper)", async () => {
    const client = makeMockClient();
    const adapter = new DiscordInboxAdapter({
      token: "tok-bot",
      clientFactory: makeFactory(client),
    });
    const received: InboxMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });
    await client.emitMessage(
      makeMessage({ author: { id: "self", username: "tutti", bot: true } }),
    );
    expect(received).toEqual([]);
  });

  it("send() fetches the channel and calls channel.send with the reply text", async () => {
    const channel = makeChannel("C42");
    const client = makeMockClient(channel);
    const adapter = new DiscordInboxAdapter({
      token: "tok-send",
      clientFactory: makeFactory(client),
    });
    await adapter.start(async () => {});
    await adapter.send("C42", { text: "pong" });
    expect(client.channels.fetch).toHaveBeenCalledWith("C42");
    expect(channel.send).toHaveBeenCalledWith("pong");
  });

  it("send() throws on a missing channel", async () => {
    const channel = makeChannel("C42");
    const client = makeMockClient(channel);
    const adapter = new DiscordInboxAdapter({
      token: "tok-missing-channel",
      clientFactory: makeFactory(client),
    });
    await adapter.start(async () => {});
    await expect(adapter.send("C-other", { text: "x" })).rejects.toThrow(/not found/);
  });

  it("send() skips empty replies", async () => {
    const channel = makeChannel("C42");
    const client = makeMockClient(channel);
    const adapter = new DiscordInboxAdapter({
      token: "tok-empty",
      clientFactory: makeFactory(client),
    });
    await adapter.start(async () => {});
    await adapter.send("C42", { text: "" });
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("stop() releases the wrapper ref so the cache empties", async () => {
    const client = makeMockClient();
    const adapter = new DiscordInboxAdapter({
      token: "tok-stop",
      clientFactory: makeFactory(client),
    });
    await adapter.start(async () => {});
    expect(DiscordClientWrapper.cache.has("tok-stop")).toBe(true);
    await adapter.stop();
    expect(DiscordClientWrapper.cache.has("tok-stop")).toBe(false);
  });

  it("start/stop are idempotent", async () => {
    const client = makeMockClient();
    const adapter = new DiscordInboxAdapter({
      token: "tok-idem",
      clientFactory: makeFactory(client),
    });
    await adapter.start(async () => {});
    await adapter.start(async () => {});
    await adapter.stop();
    await adapter.stop();
    expect(client.login).toHaveBeenCalledTimes(1);
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });
});
