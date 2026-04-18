import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext } from "@tuttiai/types";
import { DiscordVoice } from "../src/index.js";
import type {
  DiscordClient,
  DiscordClientLike,
  DiscordGuildLike,
  DiscordMessageLike,
  DiscordTextChannelLike,
  DiscordUserLike,
} from "../src/client.js";
import { DiscordClientWrapper } from "../src/client.js";
import { createPostMessageTool } from "../src/tools/post-message.js";
import { createEditMessageTool } from "../src/tools/edit-message.js";
import { createDeleteMessageTool } from "../src/tools/delete-message.js";
import { createAddReactionTool } from "../src/tools/add-reaction.js";
import { createListMessagesTool } from "../src/tools/list-messages.js";
import { createGetMessageTool } from "../src/tools/get-message.js";
import { createListChannelsTool } from "../src/tools/list-channels.js";
import { createListMembersTool } from "../src/tools/list-members.js";
import { createSendDmTool } from "../src/tools/send-dm.js";
import { createSearchMessagesTool } from "../src/tools/search-messages.js";
import { createGetGuildInfoTool } from "../src/tools/get-guild-info.js";
import {
  discordErrorMessage,
  truncate,
  formatNumber,
  messageUrl,
} from "../src/utils/format.js";

const ctx: ToolContext = { session_id: "test", agent_name: "test" };

// ---------------------------------------------------------------------------
// Mock-factory helpers — fluent builders so individual tests stay short.
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<DiscordMessageLike> = {}): DiscordMessageLike {
  return {
    id: overrides.id ?? "m1",
    channelId: overrides.channelId ?? "c1",
    guildId: overrides.guildId ?? "g1",
    content: overrides.content ?? "hello",
    createdTimestamp: overrides.createdTimestamp ?? 1_700_000_000_000,
    editedTimestamp: overrides.editedTimestamp ?? null,
    author: overrides.author ?? { id: "u1", username: "alice" },
    edit: overrides.edit ?? vi.fn(async (c: string) => makeMessage({ ...overrides, content: c })),
    delete: overrides.delete ?? vi.fn(async () => undefined),
    react: overrides.react ?? vi.fn(async () => undefined),
    url: overrides.url,
  };
}

interface MockChannel extends DiscordTextChannelLike {
  send: ReturnType<typeof vi.fn>;
  messages: {
    fetch: ReturnType<typeof vi.fn>;
  };
}

function makeChannel(overrides: Partial<MockChannel> = {}): MockChannel {
  return {
    id: overrides.id ?? "c1",
    name: overrides.name ?? "general",
    guildId: overrides.guildId ?? "g1",
    send: overrides.send ?? vi.fn(),
    messages: overrides.messages ?? {
      fetch: vi.fn(),
    },
  };
}

interface MockGuild extends DiscordGuildLike {
  channels: { fetch: ReturnType<typeof vi.fn> };
  members: { fetch: ReturnType<typeof vi.fn> };
  iconURL: ReturnType<typeof vi.fn>;
}

function makeGuild(overrides: Partial<MockGuild> = {}): MockGuild {
  return {
    id: overrides.id ?? "g1",
    name: overrides.name ?? "My Server",
    memberCount: overrides.memberCount ?? 42,
    createdTimestamp: overrides.createdTimestamp ?? 1_600_000_000_000,
    iconURL: overrides.iconURL ?? vi.fn(() => "https://cdn.discordapp.com/icons/g1/x.png"),
    channels: overrides.channels ?? { fetch: vi.fn() },
    members: overrides.members ?? { fetch: vi.fn() },
  };
}

interface MockClient extends DiscordClientLike {
  channels: { fetch: ReturnType<typeof vi.fn> };
  guilds: { fetch: ReturnType<typeof vi.fn> };
  users: { fetch: ReturnType<typeof vi.fn> };
  destroy: ReturnType<typeof vi.fn>;
  login: ReturnType<typeof vi.fn>;
}

function makeMockClient(): MockClient {
  return {
    channels: { fetch: vi.fn() },
    guilds: { fetch: vi.fn() },
    users: { fetch: vi.fn() },
    destroy: vi.fn(async () => undefined),
    login: vi.fn(async () => "token"),
  };
}

function readyClient(
  overrides?: Partial<MockClient>,
): { client: DiscordClient; mock: MockClient; wrapper: DiscordClientWrapper } {
  const mock = { ...makeMockClient(), ...overrides } as MockClient;
  const wrapper = new DiscordClientWrapper("fake-token", () => mock);
  return { client: { kind: "ready", wrapper }, mock, wrapper };
}

let env: ReturnType<typeof readyClient>;

beforeEach(() => {
  env = readyClient();
});

// ---------------------------------------------------------------------------
// DiscordVoice
// ---------------------------------------------------------------------------

describe("DiscordVoice", () => {
  it("exposes 11 tools and required_permissions=['network']", () => {
    const voice = new DiscordVoice({ token: "fake", clientFactory: () => makeMockClient() });
    expect(voice.name).toBe("discord");
    expect(voice.required_permissions).toEqual(["network"]);
    expect(voice.tools).toHaveLength(11);
    const names = voice.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "add_reaction",
        "delete_message",
        "edit_message",
        "get_guild_info",
        "get_message",
        "list_channels",
        "list_members",
        "list_messages",
        "post_message",
        "search_messages",
        "send_dm",
      ].sort(),
    );
  });

  it("marks the five write tools as destructive", () => {
    const voice = new DiscordVoice({ token: "fake", clientFactory: () => makeMockClient() });
    const destructive = voice.tools
      .filter((t) => t.destructive === true)
      .map((t) => t.name)
      .sort();
    expect(destructive).toEqual(
      ["add_reaction", "delete_message", "edit_message", "post_message", "send_dm"].sort(),
    );
  });

  it("teardown() destroys the underlying client when logged in", async () => {
    const mock = makeMockClient();
    const voice = new DiscordVoice({ token: "fake", clientFactory: () => mock });
    // Trigger a login so the client is actually created.
    mock.channels.fetch.mockResolvedValue(
      makeChannel({ send: vi.fn(async () => makeMessage()) }),
    );
    const post = voice.tools.find((t) => t.name === "post_message");
    expect(post).toBeDefined();
    await post!.execute(
      post!.parameters.parse({ channel_id: "c1", content: "hi" }),
      ctx,
    );
    await voice.teardown();
    expect(mock.destroy).toHaveBeenCalledTimes(1);
  });

  it("teardown() is a no-op when the voice was never used", async () => {
    const mock = makeMockClient();
    const voice = new DiscordVoice({ token: "fake", clientFactory: () => mock });
    await voice.teardown();
    expect(mock.destroy).not.toHaveBeenCalled();
    expect(mock.login).not.toHaveBeenCalled();
  });

  it("teardown() is a no-op when token is missing", async () => {
    const voice = new DiscordVoice({});
    await expect(voice.teardown()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Client wrapper — lazy login semantics
// ---------------------------------------------------------------------------

describe("DiscordClientWrapper", () => {
  it("does not call login() until getClient() is awaited", async () => {
    const mock = makeMockClient();
    const wrapper = new DiscordClientWrapper("t", () => mock);
    expect(mock.login).not.toHaveBeenCalled();
    await wrapper.getClient();
    expect(mock.login).toHaveBeenCalledTimes(1);
    expect(mock.login).toHaveBeenCalledWith("t");
  });

  it("reuses the same Client across concurrent getClient() calls", async () => {
    const mock = makeMockClient();
    const wrapper = new DiscordClientWrapper("t", () => mock);
    const [a, b] = await Promise.all([wrapper.getClient(), wrapper.getClient()]);
    expect(a).toBe(b);
    expect(mock.login).toHaveBeenCalledTimes(1);
  });

  it("retries login after a previous login() rejection", async () => {
    let call = 0;
    const login = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error("bad token");
      return "ok";
    });
    const mock: MockClient = { ...makeMockClient(), login };
    const wrapper = new DiscordClientWrapper("t", () => mock);
    await expect(wrapper.getClient()).rejects.toThrow("bad token");
    await expect(wrapper.getClient()).resolves.toBe(mock);
    expect(login).toHaveBeenCalledTimes(2);
  });

  it("destroy() clears the cached Client", async () => {
    const mock = makeMockClient();
    const wrapper = new DiscordClientWrapper("t", () => mock);
    await wrapper.getClient();
    await wrapper.destroy();
    expect(mock.destroy).toHaveBeenCalledTimes(1);
    // A second getClient() should re-login via the factory.
    await wrapper.getClient();
    expect(mock.login).toHaveBeenCalledTimes(2);
  });

  it("destroy() before getClient() is a no-op", async () => {
    const mock = makeMockClient();
    const wrapper = new DiscordClientWrapper("t", () => mock);
    await wrapper.destroy();
    expect(mock.destroy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Auth gating — missing token short-circuits every tool
// ---------------------------------------------------------------------------

describe("auth gating", () => {
  it("post_message returns is_error when no token configured", async () => {
    const missing: DiscordClient = { kind: "missing", message: "Discord not configured." };
    const tool = createPostMessageTool(missing);
    const result = await tool.execute(
      tool.parameters.parse({ channel_id: "c1", content: "hi" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not configured");
  });

  it("list_messages returns is_error when no token configured", async () => {
    const missing: DiscordClient = { kind: "missing", message: "Discord not configured." };
    const tool = createListMessagesTool(missing);
    const result = await tool.execute(tool.parameters.parse({ channel_id: "c1" }), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not configured");
  });
});

// ---------------------------------------------------------------------------
// post_message
// ---------------------------------------------------------------------------

describe("post_message", () => {
  it("posts a simple message and returns id + url", async () => {
    const sent = makeMessage({ id: "m42", channelId: "c1", guildId: "g1" });
    const channel = makeChannel({ send: vi.fn(async () => sent) });
    env.mock.channels.fetch.mockResolvedValue(channel);

    const tool = createPostMessageTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel_id: "c1", content: "hi there" }),
      ctx,
    );
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("m42");
    expect(result.content).toContain("#general");
    expect(channel.send).toHaveBeenCalledWith({ content: "hi there" });
  });

  it("passes reply_to_message_id through as a messageReference", async () => {
    const channel = makeChannel({ send: vi.fn(async () => makeMessage()) });
    env.mock.channels.fetch.mockResolvedValue(channel);

    const tool = createPostMessageTool(env.client);
    await tool.execute(
      tool.parameters.parse({ channel_id: "c1", content: "reply", reply_to_message_id: "m99" }),
      ctx,
    );
    expect(channel.send).toHaveBeenCalledWith({
      content: "reply",
      reply: { messageReference: "m99" },
    });
  });

  it("returns is_error when the channel is null (inaccessible)", async () => {
    env.mock.channels.fetch.mockResolvedValue(null);
    const tool = createPostMessageTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel_id: "cX", content: "x" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("returns is_error on API failure", async () => {
    env.mock.channels.fetch.mockRejectedValue(
      Object.assign(new Error("rate"), { status: 429 }),
    );
    const tool = createPostMessageTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel_id: "c1", content: "x" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("[429]");
    expect(result.content).toContain("rate limit");
  });
});

// ---------------------------------------------------------------------------
// edit_message
// ---------------------------------------------------------------------------

describe("edit_message", () => {
  it("edits a message", async () => {
    const editFn = vi.fn(async (c: string) => makeMessage({ id: "m1", content: c }));
    const msg = makeMessage({ id: "m1", edit: editFn });
    const channel = makeChannel({
      messages: { fetch: vi.fn(async () => msg) },
    });
    env.mock.channels.fetch.mockResolvedValue(channel);

    const tool = createEditMessageTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel_id: "c1", message_id: "m1", content: "new text" }),
      ctx,
    );
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("Edited message m1");
    expect(editFn).toHaveBeenCalledWith("new text");
  });

  it("returns is_error when the message fetch fails", async () => {
    const channel = makeChannel({
      messages: {
        fetch: vi.fn(async () => {
          throw Object.assign(new Error("gone"), { status: 404 });
        }),
      },
    });
    env.mock.channels.fetch.mockResolvedValue(channel);
    const tool = createEditMessageTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel_id: "c1", message_id: "m1", content: "x" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("[404]");
  });
});

// ---------------------------------------------------------------------------
// delete_message
// ---------------------------------------------------------------------------

describe("delete_message", () => {
  it("deletes and confirms by id", async () => {
    const del = vi.fn(async () => undefined);
    const msg = makeMessage({ id: "m2", delete: del });
    const channel = makeChannel({ messages: { fetch: vi.fn(async () => msg) } });
    env.mock.channels.fetch.mockResolvedValue(channel);

    const tool = createDeleteMessageTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel_id: "c1", message_id: "m2" }),
      ctx,
    );
    expect(result.content).toBe("Deleted message m2");
    expect(del).toHaveBeenCalled();
  });

  it("returns is_error on channel not accessible", async () => {
    env.mock.channels.fetch.mockResolvedValue(null);
    const tool = createDeleteMessageTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel_id: "cX", message_id: "m1" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// add_reaction
// ---------------------------------------------------------------------------

describe("add_reaction", () => {
  it("reacts with a unicode emoji", async () => {
    const react = vi.fn(async () => undefined);
    const msg = makeMessage({ id: "m3", react });
    const channel = makeChannel({ messages: { fetch: vi.fn(async () => msg) } });
    env.mock.channels.fetch.mockResolvedValue(channel);

    const tool = createAddReactionTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel_id: "c1", message_id: "m3", emoji: "👍" }),
      ctx,
    );
    expect(result.content).toContain("Reacted with 👍");
    expect(react).toHaveBeenCalledWith("👍");
  });

  it("returns is_error when react() rejects", async () => {
    const react = vi.fn(async () => {
      throw Object.assign(new Error("forbidden"), { status: 403 });
    });
    const msg = makeMessage({ react });
    const channel = makeChannel({ messages: { fetch: vi.fn(async () => msg) } });
    env.mock.channels.fetch.mockResolvedValue(channel);
    const tool = createAddReactionTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel_id: "c1", message_id: "m3", emoji: "👍" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("forbade");
  });
});

// ---------------------------------------------------------------------------
// list_messages
// ---------------------------------------------------------------------------

describe("list_messages", () => {
  it("formats a multi-message list with author + preview", async () => {
    const ms = new Map<string, DiscordMessageLike>([
      ["m1", makeMessage({ id: "m1", content: "first", author: { id: "u1", username: "alice" } })],
      ["m2", makeMessage({ id: "m2", content: "second", author: { id: "u2", username: "bob" } })],
    ]);
    const channel = makeChannel({ messages: { fetch: vi.fn(async () => ms) } });
    env.mock.channels.fetch.mockResolvedValue(channel);

    const tool = createListMessagesTool(env.client);
    const result = await tool.execute(tool.parameters.parse({ channel_id: "c1" }), ctx);
    expect(result.content).toContain("2 messages in #general");
    expect(result.content).toContain("@alice");
    expect(result.content).toContain("@bob");
    expect(result.content).toContain("first");
    expect(result.content).toContain("second");
  });

  it("reports an empty channel", async () => {
    const channel = makeChannel({ messages: { fetch: vi.fn(async () => new Map()) } });
    env.mock.channels.fetch.mockResolvedValue(channel);
    const tool = createListMessagesTool(env.client);
    const result = await tool.execute(tool.parameters.parse({ channel_id: "c1" }), ctx);
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("No messages");
  });

  it("passes before/after pagination params through", async () => {
    const fetchFn = vi.fn(async () => new Map());
    const channel = makeChannel({ messages: { fetch: fetchFn } });
    env.mock.channels.fetch.mockResolvedValue(channel);
    const tool = createListMessagesTool(env.client);
    await tool.execute(
      tool.parameters.parse({
        channel_id: "c1",
        limit: 10,
        before: "m99",
        after: "m1",
      }),
      ctx,
    );
    expect(fetchFn).toHaveBeenCalledWith({ limit: 10, before: "m99", after: "m1" });
  });

  it("returns is_error on API failure", async () => {
    env.mock.channels.fetch.mockRejectedValue(
      Object.assign(new Error("auth"), { status: 401 }),
    );
    const tool = createListMessagesTool(env.client);
    const result = await tool.execute(tool.parameters.parse({ channel_id: "c1" }), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("authentication failed");
  });
});

// ---------------------------------------------------------------------------
// get_message
// ---------------------------------------------------------------------------

describe("get_message", () => {
  it("renders a full message block with bot badge + URL", async () => {
    const msg = makeMessage({
      id: "m5",
      content: "Hello, world",
      author: { id: "u1", username: "alice-bot", bot: true },
      createdTimestamp: Date.parse("2026-01-01T00:00:00Z"),
      editedTimestamp: Date.parse("2026-01-02T00:00:00Z"),
      channelId: "c1",
      guildId: "g1",
    });
    const channel = makeChannel({
      messages: { fetch: vi.fn(async () => msg) },
      name: "general",
    });
    env.mock.channels.fetch.mockResolvedValue(channel);

    const tool = createGetMessageTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel_id: "c1", message_id: "m5" }),
      ctx,
    );
    expect(result.content).toContain("Message m5");
    expect(result.content).toContain("@alice-bot [bot]");
    expect(result.content).toContain("#general");
    expect(result.content).toContain("Edited:");
    expect(result.content).toContain("Hello, world");
    expect(result.content).toContain("https://discord.com/channels/g1/c1/m5");
  });

  it("uses '(no text content)' when content is empty", async () => {
    const msg = makeMessage({ content: "" });
    const channel = makeChannel({ messages: { fetch: vi.fn(async () => msg) } });
    env.mock.channels.fetch.mockResolvedValue(channel);
    const tool = createGetMessageTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel_id: "c1", message_id: "m1" }),
      ctx,
    );
    expect(result.content).toContain("(no text content)");
  });
});

// ---------------------------------------------------------------------------
// list_channels
// ---------------------------------------------------------------------------

describe("list_channels", () => {
  it("lists text-capable channels and skips voice/null", async () => {
    const channels = new Map<string, { id: string; name: string; type: number; topic?: string | null } | null>([
      ["c1", { id: "c1", name: "general", type: 0, topic: "chit chat" }],
      ["c2", { id: "c2", name: "voice-room", type: 2 }], // GuildVoice — filtered out
      ["c3", { id: "c3", name: "news", type: 5 }],
      ["c4", null], // a null entry from partial fetch
    ]);
    const guild = makeGuild({
      channels: { fetch: vi.fn(async () => channels) },
    });
    env.mock.guilds.fetch.mockResolvedValue(guild);

    const tool = createListChannelsTool(env.client);
    const result = await tool.execute(tool.parameters.parse({ guild_id: "g1" }), ctx);
    expect(result.content).toContain("2 text channels");
    expect(result.content).toContain("#general");
    expect(result.content).toContain("chit chat");
    expect(result.content).toContain("#news");
    expect(result.content).not.toContain("voice-room");
  });

  it("reports no text channels", async () => {
    const guild = makeGuild({
      channels: { fetch: vi.fn(async () => new Map()) },
    });
    env.mock.guilds.fetch.mockResolvedValue(guild);
    const tool = createListChannelsTool(env.client);
    const result = await tool.execute(tool.parameters.parse({ guild_id: "g1" }), ctx);
    expect(result.content).toContain("No text channels");
  });

  it("returns is_error on API failure", async () => {
    env.mock.guilds.fetch.mockRejectedValue(
      Object.assign(new Error("missing"), { status: 404 }),
    );
    const tool = createListChannelsTool(env.client);
    const result = await tool.execute(tool.parameters.parse({ guild_id: "gX" }), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Not found");
  });
});

// ---------------------------------------------------------------------------
// list_members
// ---------------------------------------------------------------------------

describe("list_members", () => {
  it("formats members with roles, bot badge and join timestamp", async () => {
    const members = new Map([
      [
        "u1",
        {
          id: "u1",
          user: { id: "u1", username: "alice" },
          joinedTimestamp: Date.parse("2026-01-01T00:00:00Z"),
          roles: {
            cache: new Map([
              ["r0", { id: "r0", name: "@everyone" }],
              ["r1", { id: "r1", name: "Admin" }],
            ]),
          },
        },
      ],
      [
        "u2",
        {
          id: "u2",
          user: { id: "u2", username: "botly", bot: true },
          joinedTimestamp: null,
          roles: { cache: new Map() },
        },
      ],
    ]);
    const guild = makeGuild({ members: { fetch: vi.fn(async () => members) } });
    env.mock.guilds.fetch.mockResolvedValue(guild);

    const tool = createListMembersTool(env.client);
    const result = await tool.execute(tool.parameters.parse({ guild_id: "g1" }), ctx);
    expect(result.content).toContain("2 members");
    expect(result.content).toContain("@alice");
    expect(result.content).toContain("roles: Admin");
    expect(result.content).not.toContain("@everyone");
    expect(result.content).toContain("@botly [bot]");
    expect(result.content).toContain("joined unknown");
  });

  it("reports empty results when the intent is missing", async () => {
    const guild = makeGuild({ members: { fetch: vi.fn(async () => new Map()) } });
    env.mock.guilds.fetch.mockResolvedValue(guild);
    const tool = createListMembersTool(env.client);
    const result = await tool.execute(tool.parameters.parse({ guild_id: "g1" }), ctx);
    expect(result.content).toContain("missing intent");
  });
});

// ---------------------------------------------------------------------------
// send_dm
// ---------------------------------------------------------------------------

describe("send_dm", () => {
  it("delivers a DM via user.send()", async () => {
    const sendFn = vi.fn(async () => makeMessage({ id: "dm1" }));
    const user: DiscordUserLike = { id: "u9", username: "target", send: sendFn };
    env.mock.users.fetch.mockResolvedValue(user);

    const tool = createSendDmTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ user_id: "u9", content: "hi!" }),
      ctx,
    );
    expect(result.content).toContain("Sent DM dm1 to @target");
    expect(sendFn).toHaveBeenCalledWith("hi!");
  });

  it("returns is_error when users.fetch rejects", async () => {
    env.mock.users.fetch.mockRejectedValue(
      Object.assign(new Error("gone"), { status: 404 }),
    );
    const tool = createSendDmTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ user_id: "uX", content: "x" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Not found");
  });
});

// ---------------------------------------------------------------------------
// search_messages
// ---------------------------------------------------------------------------

describe("search_messages", () => {
  it("filters the scan window to case-insensitive substring matches", async () => {
    const fetchFn = vi.fn(async () =>
      new Map([
        ["m1", makeMessage({ id: "m1", content: "Hello World" })],
        ["m2", makeMessage({ id: "m2", content: "boring" })],
        ["m3", makeMessage({ id: "m3", content: "hello again" })],
      ]),
    );
    const channel = makeChannel({ messages: { fetch: fetchFn } });
    env.mock.channels.fetch.mockResolvedValue(channel);

    const tool = createSearchMessagesTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel_id: "c1", query: "hello" }),
      ctx,
    );
    expect(result.content).toContain("2 matches");
    expect(result.content).toContain("m1");
    expect(result.content).toContain("m3");
    expect(result.content).not.toContain("m2");
    expect(fetchFn).toHaveBeenCalledWith({ limit: 100 }); // scan window
  });

  it("truncates by the user-supplied limit after filtering", async () => {
    const messages = new Map();
    for (let i = 1; i <= 5; i++) {
      messages.set(`m${i}`, makeMessage({ id: `m${i}`, content: `match ${i}` }));
    }
    const channel = makeChannel({ messages: { fetch: vi.fn(async () => messages) } });
    env.mock.channels.fetch.mockResolvedValue(channel);

    const tool = createSearchMessagesTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel_id: "c1", query: "match", limit: 2 }),
      ctx,
    );
    expect(result.content).toContain("2 matches");
  });

  it("reports no matches", async () => {
    const channel = makeChannel({
      messages: { fetch: vi.fn(async () => new Map([["m1", makeMessage({ content: "xyz" })]])) },
    });
    env.mock.channels.fetch.mockResolvedValue(channel);
    const tool = createSearchMessagesTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel_id: "c1", query: "abc" }),
      ctx,
    );
    expect(result.content).toContain("No matches");
  });
});

// ---------------------------------------------------------------------------
// get_guild_info
// ---------------------------------------------------------------------------

describe("get_guild_info", () => {
  it("returns name, member count, channel count, icon", async () => {
    const guild = makeGuild({
      id: "g1",
      name: "Cool Server",
      memberCount: 1234,
      channels: {
        fetch: vi.fn(async () =>
          new Map([
            ["c1", { id: "c1", name: "general", type: 0 }],
            ["c2", { id: "c2", name: "voice", type: 2 }],
          ]),
        ),
      },
    });
    env.mock.guilds.fetch.mockResolvedValue(guild);

    const tool = createGetGuildInfoTool(env.client);
    const result = await tool.execute(tool.parameters.parse({ guild_id: "g1" }), ctx);
    expect(result.content).toContain("Cool Server (g1)");
    expect(result.content).toContain("Members: 1,234");
    expect(result.content).toContain("Channels: 2");
    expect(result.content).toContain("Icon:");
  });

  it("omits the icon line when iconURL() returns null", async () => {
    const guild = makeGuild({
      iconURL: vi.fn(() => null),
      channels: { fetch: vi.fn(async () => new Map()) },
    });
    env.mock.guilds.fetch.mockResolvedValue(guild);
    const tool = createGetGuildInfoTool(env.client);
    const result = await tool.execute(tool.parameters.parse({ guild_id: "g1" }), ctx);
    expect(result.content).not.toContain("Icon:");
  });
});

// ---------------------------------------------------------------------------
// format utilities
// ---------------------------------------------------------------------------

describe("format utilities", () => {
  it("discordErrorMessage maps every documented status branch", () => {
    expect(discordErrorMessage(Object.assign(new Error("x"), { status: 401 }))).toContain(
      "authentication failed",
    );
    expect(discordErrorMessage(Object.assign(new Error("x"), { status: 403 }))).toContain(
      "forbade",
    );
    expect(discordErrorMessage(Object.assign(new Error("x"), { status: 404 }))).toContain(
      "Not found",
    );
    expect(discordErrorMessage(Object.assign(new Error("x"), { status: 429 }))).toContain(
      "rate limit",
    );
  });

  it("discordErrorMessage surfaces rawError.message when present", () => {
    const err = Object.assign(new Error("Bad"), {
      rawError: { message: "Missing Access" },
    });
    expect(discordErrorMessage(err)).toContain("Missing Access");
  });

  it("discordErrorMessage handles generic Error", () => {
    expect(discordErrorMessage(new Error("boom"))).toContain("boom");
  });

  it("discordErrorMessage handles non-Error input", () => {
    expect(discordErrorMessage("string error")).toBe("string error");
  });

  it("truncate shortens long strings", () => {
    expect(truncate("abcdefghij", 7)).toBe("abcd...");
  });

  it("truncate preserves short strings", () => {
    expect(truncate("abc", 10)).toBe("abc");
  });

  it("formatNumber adds commas", () => {
    expect(formatNumber(12345)).toBe("12,345");
  });

  it("messageUrl uses guild id when provided", () => {
    expect(messageUrl("g1", "c1", "m1")).toBe("https://discord.com/channels/g1/c1/m1");
  });

  it("messageUrl falls back to '@me' for DMs", () => {
    expect(messageUrl(null, "c1", "m1")).toBe("https://discord.com/channels/@me/c1/m1");
    expect(messageUrl(undefined, "c1", "m1")).toBe("https://discord.com/channels/@me/c1/m1");
  });
});
