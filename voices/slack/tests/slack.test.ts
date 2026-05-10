import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext } from "@tuttiai/types";
import { SlackVoice } from "../src/index.js";
import type {
  SlackClient,
  SlackClientLike,
  SlackConversationLike,
  SlackMessageLike,
  SlackTeamLike,
  SlackUserLike,
} from "../src/client.js";
import { SlackClientWrapper, createSlackClient } from "../src/client.js";
import type { SlackEventEnvelope, SlackEventLike } from "../src/socket-mode.js";
import { createPostMessageTool } from "../src/tools/post-message.js";
import { createUpdateMessageTool } from "../src/tools/update-message.js";
import { createDeleteMessageTool } from "../src/tools/delete-message.js";
import { createAddReactionTool } from "../src/tools/add-reaction.js";
import { createListMessagesTool } from "../src/tools/list-messages.js";
import { createGetMessageTool } from "../src/tools/get-message.js";
import { createListChannelsTool } from "../src/tools/list-channels.js";
import { createListMembersTool } from "../src/tools/list-members.js";
import { createSendDmTool } from "../src/tools/send-dm.js";
import { createSearchMessagesTool } from "../src/tools/search-messages.js";
import { createGetWorkspaceInfoTool } from "../src/tools/get-workspace-info.js";
import {
  authorLabel,
  formatNumber,
  formatTs,
  slackErrorMessage,
  truncate,
  tsToDate,
} from "../src/utils/format.js";

const ctx: ToolContext = { session_id: "test", agent_name: "test" };

// ---------------------------------------------------------------------------
// Mock-factory helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<SlackMessageLike> = {}): SlackMessageLike {
  return {
    ts: overrides.ts ?? "1700000000.000100",
    user: overrides.user ?? "U1",
    username: overrides.username,
    bot_id: overrides.bot_id,
    text: overrides.text ?? "hello",
    thread_ts: overrides.thread_ts,
    edited: overrides.edited,
    channel: overrides.channel,
    type: overrides.type ?? "message",
  };
}

interface MockClient extends SlackClientLike {
  chat: {
    postMessage: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getPermalink: ReturnType<typeof vi.fn>;
  };
  reactions: { add: ReturnType<typeof vi.fn> };
  conversations: {
    history: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
  };
  users: {
    list: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
  };
  team: { info: ReturnType<typeof vi.fn> };
}

function makeMockClient(): MockClient {
  return {
    chat: {
      postMessage: vi.fn(async () => ({ ok: true, ts: "1700000000.001", channel: "C1" })),
      update: vi.fn(async () => ({ ok: true, ts: "1700000000.001", channel: "C1" })),
      delete: vi.fn(async () => ({ ok: true })),
      getPermalink: vi.fn(async () => ({
        ok: true,
        permalink: "https://acme.slack.com/archives/C1/p1700000000001",
      })),
    },
    reactions: { add: vi.fn(async () => ({ ok: true })) },
    conversations: {
      history: vi.fn(async () => ({ ok: true, messages: [] })),
      list: vi.fn(async () => ({ ok: true, channels: [] })),
      info: vi.fn(async () => ({ ok: true, channel: undefined })),
      open: vi.fn(async () => ({ ok: true, channel: { id: "D1" } })),
    },
    users: {
      list: vi.fn(async () => ({ ok: true, members: [] })),
      info: vi.fn(async () => ({ ok: true, user: undefined })),
    },
    team: { info: vi.fn(async () => ({ ok: true, team: undefined })) },
  };
}

function readyClient(
  overrides?: Partial<MockClient>,
): { client: SlackClient; mock: MockClient; wrapper: SlackClientWrapper } {
  const mock = { ...makeMockClient(), ...overrides } as MockClient;
  const wrapper = new SlackClientWrapper("xoxb-fake", () => mock);
  return { client: { kind: "ready", wrapper }, mock, wrapper };
}

let env: ReturnType<typeof readyClient>;

beforeEach(() => {
  // Reset the token-keyed cache so SlackVoice instances created in
  // separate tests with the same token don't share a cached wrapper.
  SlackClientWrapper.cache.clear();
  env = readyClient();
});

/** Build a Slack-shaped error like @slack/web-api throws. */
function slackErr(code: string, status?: number): Error {
  const e = new Error(`slack api error: ${code}`);
  return Object.assign(e, { data: { error: code }, status });
}

// ---------------------------------------------------------------------------
// SlackVoice
// ---------------------------------------------------------------------------

describe("SlackVoice", () => {
  it("exposes 11 tools and required_permissions=['network']", () => {
    const voice = new SlackVoice({ token: "xoxb-fake", clientFactory: () => makeMockClient() });
    expect(voice.name).toBe("slack");
    expect(voice.required_permissions).toEqual(["network"]);
    expect(voice.tools).toHaveLength(11);
    const names = voice.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "add_reaction",
        "delete_message",
        "get_message",
        "get_workspace_info",
        "list_channels",
        "list_members",
        "list_messages",
        "post_message",
        "search_messages",
        "send_dm",
        "update_message",
      ].sort(),
    );
  });

  it("marks the five write tools as destructive", () => {
    const voice = new SlackVoice({ token: "xoxb-fake", clientFactory: () => makeMockClient() });
    const destructive = voice.tools
      .filter((t) => t.destructive === true)
      .map((t) => t.name)
      .sort();
    expect(destructive).toEqual(
      ["add_reaction", "delete_message", "post_message", "send_dm", "update_message"].sort(),
    );
  });

  it("teardown() clears the cached client when initialised", async () => {
    const mock = makeMockClient();
    const voice = new SlackVoice({ token: "xoxb-fake", clientFactory: () => mock });
    const post = voice.tools.find((t) => t.name === "post_message");
    expect(post).toBeDefined();
    await post!.execute(post!.parameters.parse({ channel: "C1", text: "hi" }), ctx);
    await expect(voice.teardown()).resolves.toBeUndefined();
  });

  it("teardown() is a no-op when the voice was never used", async () => {
    const mock = makeMockClient();
    const voice = new SlackVoice({ token: "xoxb-fake", clientFactory: () => mock });
    await voice.teardown();
    expect(mock.chat.postMessage).not.toHaveBeenCalled();
  });

  it("teardown() is a no-op when token is missing", async () => {
    const voice = new SlackVoice({});
    await expect(voice.teardown()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Client wrapper — lazy init semantics
// ---------------------------------------------------------------------------

describe("SlackClientWrapper", () => {
  it("does not call the factory until getClient() is awaited", async () => {
    const factory = vi.fn(() => makeMockClient());
    const wrapper = new SlackClientWrapper("xoxb-t", factory);
    expect(factory).not.toHaveBeenCalled();
    await wrapper.getClient();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith("xoxb-t");
  });

  it("reuses the same client across concurrent getClient() calls", async () => {
    const mock = makeMockClient();
    const wrapper = new SlackClientWrapper("xoxb-t", () => mock);
    const [a, b] = await Promise.all([wrapper.getClient(), wrapper.getClient()]);
    expect(a).toBe(b);
  });

  it("retries init after a previous factory throw", async () => {
    let call = 0;
    const factory = vi.fn(() => {
      call += 1;
      if (call === 1) throw new Error("bad init");
      return makeMockClient();
    });
    const wrapper = new SlackClientWrapper("xoxb-t", factory);
    await expect(wrapper.getClient()).rejects.toThrow("bad init");
    await expect(wrapper.getClient()).resolves.toBeDefined();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("destroy() clears the cached client so the next getClient() rebuilds", async () => {
    const factory = vi.fn(() => makeMockClient());
    const wrapper = new SlackClientWrapper("xoxb-t", factory);
    await wrapper.getClient();
    await wrapper.destroy();
    await wrapper.getClient();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("destroy() before getClient() is a no-op", async () => {
    const factory = vi.fn(() => makeMockClient());
    const wrapper = new SlackClientWrapper("xoxb-t", factory);
    await wrapper.destroy();
    expect(factory).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Token-keyed cache + ref counting (forToken)
// ---------------------------------------------------------------------------

describe("SlackClientWrapper.forToken", () => {
  it("returns the same instance for the same token across callers", () => {
    const a = SlackClientWrapper.forToken("xoxb-shared", () => makeMockClient());
    const b = SlackClientWrapper.forToken("xoxb-shared", () => makeMockClient());
    expect(a).toBe(b);
    expect(a._refCount).toBe(2);
  });

  it("returns distinct instances for different tokens", () => {
    const a = SlackClientWrapper.forToken("xoxb-A", () => makeMockClient());
    const b = SlackClientWrapper.forToken("xoxb-B", () => makeMockClient());
    expect(a).not.toBe(b);
    expect(a._refCount).toBe(1);
    expect(b._refCount).toBe(1);
  });

  it("only releases the cached instance after the last destroy", async () => {
    const factory = vi.fn(() => makeMockClient());
    const a = SlackClientWrapper.forToken("xoxb-rc", factory);
    const b = SlackClientWrapper.forToken("xoxb-rc", factory);
    await a.getClient();
    expect(factory).toHaveBeenCalledTimes(1);
    await a.destroy();
    expect(SlackClientWrapper.cache.has("xoxb-rc")).toBe(true);
    await b.destroy();
    expect(SlackClientWrapper.cache.has("xoxb-rc")).toBe(false);
  });

  it("createSlackClient deduplicates by token", () => {
    const factory = () => makeMockClient();
    const c1 = createSlackClient({ token: "xoxb-shared", clientFactory: factory });
    const c2 = createSlackClient({ token: "xoxb-shared", clientFactory: factory });
    if (c1.kind !== "ready" || c2.kind !== "ready") throw new Error("expected ready");
    expect(c1.wrapper).toBe(c2.wrapper);
  });

  it("standalone wrapper is independent of the cache", () => {
    const a = SlackClientWrapper.forToken("xoxb-standalone-1", () => makeMockClient());
    const b = new SlackClientWrapper("xoxb-standalone-1", () => makeMockClient());
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Socket Mode + subscribeMessage — inbound dispatch for @tuttiai/inbox
// ---------------------------------------------------------------------------

interface MockSocket {
  on: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  emit: (envelope: SlackEventEnvelope) => Promise<void>;
}

function makeMockSocket(): MockSocket {
  let listener: ((env: SlackEventEnvelope) => void | Promise<void>) | undefined;
  const on = vi.fn(
    (event: "slack_event", l: (env: SlackEventEnvelope) => void | Promise<void>) => {
      if (event === "slack_event") listener = l;
    },
  );
  const socket: MockSocket = {
    on: on,
    start: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    emit: async (env) => {
      if (!listener) throw new Error("no slack_event listener registered");
      await listener(env);
    },
  };
  return socket;
}

function makeEnvelope(event: Partial<SlackEventLike>): SlackEventEnvelope {
  return {
    envelope_id: "env-1",
    body: {
      type: "events_api",
      team_id: "T1",
      event: { type: "message", ts: "1700000000.001", ...event } as SlackEventLike,
    },
    ack: vi.fn(async () => undefined),
  };
}

describe("SlackClientWrapper.subscribeMessage (Socket Mode)", () => {
  it("throws when subscribing without an appToken", () => {
    const wrapper = SlackClientWrapper.forToken("xoxb-no-app", () => makeMockClient());
    expect(() => wrapper.subscribeMessage(vi.fn())).toThrow(/appToken/);
  });

  it("lazy-launches the socket on first subscription and installs a single dispatcher", async () => {
    const socket = makeMockSocket();
    const wrapper = SlackClientWrapper.forToken(
      "xoxb-A",
      () => makeMockClient(),
      { appToken: "xapp-A", socketModeFactory: () => socket },
    );
    expect(socket.start).not.toHaveBeenCalled();
    wrapper.subscribeMessage(vi.fn());
    wrapper.subscribeMessage(vi.fn());
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(socket.start).toHaveBeenCalledTimes(1);
    expect(socket.on).toHaveBeenCalledTimes(1);
    expect(wrapper._socketStarted).toBe(true);
  });

  it("dispatches non-bot, no-subtype message events to subscribers", async () => {
    const socket = makeMockSocket();
    const wrapper = SlackClientWrapper.forToken(
      "xoxb-B",
      () => makeMockClient(),
      { appToken: "xapp-B", socketModeFactory: () => socket },
    );
    const handler = vi.fn();
    wrapper.subscribeMessage(handler);
    await wrapper.launch();
    await socket.emit(makeEnvelope({ user: "U1", channel: "C1", text: "hello" }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0].text).toBe("hello");
  });

  it("filters out bot_id messages (loop guard)", async () => {
    const socket = makeMockSocket();
    const wrapper = SlackClientWrapper.forToken(
      "xoxb-C",
      () => makeMockClient(),
      { appToken: "xapp-C", socketModeFactory: () => socket },
    );
    const handler = vi.fn();
    wrapper.subscribeMessage(handler);
    await wrapper.launch();
    await socket.emit(makeEnvelope({ bot_id: "B1", channel: "C1", text: "from bot" }));
    expect(handler).not.toHaveBeenCalled();
  });

  it("filters out non-default subtypes (edits, joins, …)", async () => {
    const socket = makeMockSocket();
    const wrapper = SlackClientWrapper.forToken(
      "xoxb-D",
      () => makeMockClient(),
      { appToken: "xapp-D", socketModeFactory: () => socket },
    );
    const handler = vi.fn();
    wrapper.subscribeMessage(handler);
    await wrapper.launch();
    await socket.emit(makeEnvelope({ user: "U1", channel: "C1", text: "edit", subtype: "message_changed" }));
    expect(handler).not.toHaveBeenCalled();
  });

  it("ack()s every envelope before dispatch", async () => {
    const socket = makeMockSocket();
    const wrapper = SlackClientWrapper.forToken(
      "xoxb-E",
      () => makeMockClient(),
      { appToken: "xapp-E", socketModeFactory: () => socket },
    );
    wrapper.subscribeMessage(vi.fn());
    await wrapper.launch();
    const env = makeEnvelope({ user: "U1", channel: "C1", text: "hi" });
    await socket.emit(env);
    expect(env.ack).toHaveBeenCalledTimes(1);
  });

  it("a thrown handler does not stop other handlers", async () => {
    const socket = makeMockSocket();
    const wrapper = SlackClientWrapper.forToken(
      "xoxb-F",
      () => makeMockClient(),
      { appToken: "xapp-F", socketModeFactory: () => socket },
    );
    const a = vi.fn(() => {
      throw new Error("boom");
    });
    const b = vi.fn();
    wrapper.subscribeMessage(a);
    wrapper.subscribeMessage(b);
    await wrapper.launch();
    await socket.emit(makeEnvelope({ user: "U1", channel: "C1", text: "x" }));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("destroy disconnects the socket on the last release and stops dispatch", async () => {
    const socket = makeMockSocket();
    const a = SlackClientWrapper.forToken(
      "xoxb-G",
      () => makeMockClient(),
      { appToken: "xapp-G", socketModeFactory: () => socket },
    );
    const b = SlackClientWrapper.forToken("xoxb-G", () => makeMockClient());
    expect(a).toBe(b);
    a.subscribeMessage(vi.fn());
    await a.launch();
    await a.destroy();
    expect(socket.disconnect).not.toHaveBeenCalled();
    await b.destroy();
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(SlackClientWrapper.cache.has("xoxb-G")).toBe(false);
  });

  it("appToken supplied on a later forToken call promotes the cached wrapper", () => {
    const factory = () => makeMockClient();
    const a = SlackClientWrapper.forToken("xoxb-H", factory);
    expect(() => a.subscribeMessage(vi.fn())).toThrow(/appToken/);
    SlackClientWrapper.forToken("xoxb-H", factory, {
      appToken: "xapp-H",
      socketModeFactory: () => makeMockSocket(),
    });
    // Same instance — but now Socket-Mode-ready.
    expect(() => a.subscribeMessage(vi.fn())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Auth gating — missing token short-circuits every tool
// ---------------------------------------------------------------------------

describe("auth gating", () => {
  it("post_message returns is_error when no token configured", async () => {
    const missing: SlackClient = { kind: "missing", message: "Slack not configured." };
    const tool = createPostMessageTool(missing);
    const result = await tool.execute(
      tool.parameters.parse({ channel: "C1", text: "hi" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not configured");
  });

  it("list_messages returns is_error when no token configured", async () => {
    const missing: SlackClient = { kind: "missing", message: "Slack not configured." };
    const tool = createListMessagesTool(missing);
    const result = await tool.execute(tool.parameters.parse({ channel: "C1" }), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not configured");
  });

  it("get_workspace_info returns is_error when no token configured", async () => {
    const missing: SlackClient = { kind: "missing", message: "Slack not configured." };
    const tool = createGetWorkspaceInfoTool(missing);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not configured");
  });
});

// ---------------------------------------------------------------------------
// post_message
// ---------------------------------------------------------------------------

describe("post_message", () => {
  it("posts a simple message and returns ts + permalink", async () => {
    env.mock.chat.postMessage.mockResolvedValue({
      ok: true,
      ts: "1700000000.999",
      channel: "C1",
    });
    const tool = createPostMessageTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel: "C1", text: "hi there" }),
      ctx,
    );
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("1700000000.999");
    expect(result.content).toContain("C1");
    expect(result.content).toContain("https://acme.slack.com");
    expect(env.mock.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      text: "hi there",
    });
  });

  it("passes thread_ts through when supplied", async () => {
    env.mock.chat.postMessage.mockResolvedValue({
      ok: true,
      ts: "1700000000.999",
      channel: "C1",
    });
    const tool = createPostMessageTool(env.client);
    await tool.execute(
      tool.parameters.parse({ channel: "C1", text: "reply", thread_ts: "1700000000.000" }),
      ctx,
    );
    expect(env.mock.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      text: "reply",
      thread_ts: "1700000000.000",
    });
  });

  it("still succeeds when getPermalink rejects", async () => {
    env.mock.chat.postMessage.mockResolvedValue({
      ok: true,
      ts: "1700000000.999",
      channel: "C1",
    });
    env.mock.chat.getPermalink.mockRejectedValue(slackErr("unknown_error"));
    const tool = createPostMessageTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel: "C1", text: "x" }),
      ctx,
    );
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("1700000000.999");
    expect(result.content).not.toContain("https://");
  });

  it("returns is_error when Slack omits the ts", async () => {
    env.mock.chat.postMessage.mockResolvedValue({ ok: true });
    const tool = createPostMessageTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel: "C1", text: "x" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("no ts");
  });

  it("returns is_error on API failure with helpful hint", async () => {
    env.mock.chat.postMessage.mockRejectedValue(slackErr("not_in_channel"));
    const tool = createPostMessageTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel: "C1", text: "x" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Bot is not in the channel");
  });
});

// ---------------------------------------------------------------------------
// update_message
// ---------------------------------------------------------------------------

describe("update_message", () => {
  it("updates a message", async () => {
    env.mock.chat.update.mockResolvedValue({
      ok: true,
      ts: "1700000000.001",
      channel: "C1",
    });
    const tool = createUpdateMessageTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel: "C1", ts: "1700000000.001", text: "new text" }),
      ctx,
    );
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("Updated message 1700000000.001");
    expect(env.mock.chat.update).toHaveBeenCalledWith({
      channel: "C1",
      ts: "1700000000.001",
      text: "new text",
    });
  });

  it("returns is_error on cant_update_message", async () => {
    env.mock.chat.update.mockRejectedValue(slackErr("cant_update_message"));
    const tool = createUpdateMessageTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel: "C1", ts: "x", text: "y" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Bots can only edit messages they posted");
  });
});

// ---------------------------------------------------------------------------
// delete_message
// ---------------------------------------------------------------------------

describe("delete_message", () => {
  it("deletes and confirms by ts", async () => {
    env.mock.chat.delete.mockResolvedValue({ ok: true });
    const tool = createDeleteMessageTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel: "C1", ts: "1700000000.002" }),
      ctx,
    );
    expect(result.content).toBe("Deleted message 1700000000.002 from C1");
    expect(env.mock.chat.delete).toHaveBeenCalledWith({
      channel: "C1",
      ts: "1700000000.002",
    });
  });

  it("returns is_error on cant_delete_message", async () => {
    env.mock.chat.delete.mockRejectedValue(slackErr("cant_delete_message"));
    const tool = createDeleteMessageTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel: "C1", ts: "1700000000.002" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Bots can only delete messages they posted");
  });
});

// ---------------------------------------------------------------------------
// add_reaction
// ---------------------------------------------------------------------------

describe("add_reaction", () => {
  it("reacts with a plain emoji name", async () => {
    env.mock.reactions.add.mockResolvedValue({ ok: true });
    const tool = createAddReactionTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel: "C1", ts: "1700000000.003", name: "thumbsup" }),
      ctx,
    );
    expect(result.content).toContain("Reacted with :thumbsup:");
    expect(env.mock.reactions.add).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "1700000000.003",
      name: "thumbsup",
    });
  });

  it("strips surrounding colons before calling Slack", async () => {
    env.mock.reactions.add.mockResolvedValue({ ok: true });
    const tool = createAddReactionTool(env.client);
    await tool.execute(
      tool.parameters.parse({ channel: "C1", ts: "1700000000.003", name: ":tada:" }),
      ctx,
    );
    expect(env.mock.reactions.add).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "1700000000.003",
      name: "tada",
    });
  });

  it("returns is_error when reactions.add rejects", async () => {
    env.mock.reactions.add.mockRejectedValue(slackErr("ratelimited"));
    const tool = createAddReactionTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel: "C1", ts: "1700000000.003", name: "tada" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("rate limit");
  });
});

// ---------------------------------------------------------------------------
// list_messages
// ---------------------------------------------------------------------------

describe("list_messages", () => {
  it("formats a multi-message list with author + preview", async () => {
    env.mock.conversations.history.mockResolvedValue({
      ok: true,
      messages: [
        makeMessage({ ts: "1700000000.100", text: "first", username: "alice" }),
        makeMessage({ ts: "1700000000.200", text: "second", username: "bob" }),
      ],
    });
    const tool = createListMessagesTool(env.client);
    const result = await tool.execute(tool.parameters.parse({ channel: "C1" }), ctx);
    expect(result.content).toContain("2 messages in C1");
    expect(result.content).toContain("@alice");
    expect(result.content).toContain("@bob");
    expect(result.content).toContain("first");
    expect(result.content).toContain("second");
  });

  it("flags thread replies", async () => {
    env.mock.conversations.history.mockResolvedValue({
      ok: true,
      messages: [
        makeMessage({
          ts: "1700000000.300",
          text: "reply",
          thread_ts: "1700000000.100",
          username: "alice",
        }),
      ],
    });
    const tool = createListMessagesTool(env.client);
    const result = await tool.execute(tool.parameters.parse({ channel: "C1" }), ctx);
    expect(result.content).toContain("in-thread");
  });

  it("reports an empty channel", async () => {
    env.mock.conversations.history.mockResolvedValue({ ok: true, messages: [] });
    const tool = createListMessagesTool(env.client);
    const result = await tool.execute(tool.parameters.parse({ channel: "C1" }), ctx);
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("No messages");
  });

  it("passes oldest/latest pagination params through", async () => {
    env.mock.conversations.history.mockResolvedValue({ ok: true, messages: [] });
    const tool = createListMessagesTool(env.client);
    await tool.execute(
      tool.parameters.parse({
        channel: "C1",
        limit: 10,
        oldest: "1700000000.000",
        latest: "1700000999.000",
      }),
      ctx,
    );
    expect(env.mock.conversations.history).toHaveBeenCalledWith({
      channel: "C1",
      limit: 10,
      oldest: "1700000000.000",
      latest: "1700000999.000",
    });
  });

  it("returns is_error on missing scope", async () => {
    env.mock.conversations.history.mockRejectedValue(
      Object.assign(new Error("missing"), {
        data: { error: "missing_scope", needed: "channels:history" },
      }),
    );
    const tool = createListMessagesTool(env.client);
    const result = await tool.execute(tool.parameters.parse({ channel: "C1" }), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("missing a required OAuth scope");
    expect(result.content).toContain("channels:history");
  });
});

// ---------------------------------------------------------------------------
// get_message
// ---------------------------------------------------------------------------

describe("get_message", () => {
  it("renders a full message block with bot badge + URL", async () => {
    env.mock.conversations.history.mockResolvedValue({
      ok: true,
      messages: [
        makeMessage({
          ts: "1700000000.500",
          text: "Hello, world",
          username: "alice-bot",
          bot_id: "B1",
          edited: { ts: "1700000111.000" },
        }),
      ],
    });
    const tool = createGetMessageTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel: "C1", ts: "1700000000.500" }),
      ctx,
    );
    expect(result.content).toContain("Message 1700000000.500");
    expect(result.content).toContain("@alice-bot [bot]");
    expect(result.content).toContain("Channel: C1");
    expect(result.content).toContain("Edited:");
    expect(result.content).toContain("Hello, world");
    expect(result.content).toContain("https://acme.slack.com");
  });

  it("uses '(no text content)' when text is empty", async () => {
    env.mock.conversations.history.mockResolvedValue({
      ok: true,
      messages: [makeMessage({ text: "" })],
    });
    const tool = createGetMessageTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel: "C1", ts: "1700000000.500" }),
      ctx,
    );
    expect(result.content).toContain("(no text content)");
  });

  it("includes thread line for replies", async () => {
    env.mock.conversations.history.mockResolvedValue({
      ok: true,
      messages: [
        makeMessage({
          ts: "1700000000.600",
          thread_ts: "1700000000.100",
          text: "reply",
        }),
      ],
    });
    const tool = createGetMessageTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel: "C1", ts: "1700000000.600" }),
      ctx,
    );
    expect(result.content).toContain("Thread: 1700000000.100");
  });

  it("returns is_error when the message is not in history", async () => {
    env.mock.conversations.history.mockResolvedValue({ ok: true, messages: [] });
    const tool = createGetMessageTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel: "C1", ts: "X" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// list_channels
// ---------------------------------------------------------------------------

describe("list_channels", () => {
  it("lists public channels by default and includes topic", async () => {
    const channels: SlackConversationLike[] = [
      { id: "C1", name: "general", topic: { value: "announcements" } },
      { id: "C2", name: "random" },
    ];
    env.mock.conversations.list.mockResolvedValue({ ok: true, channels });
    const tool = createListChannelsTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("2 channels");
    expect(result.content).toContain("#general");
    expect(result.content).toContain("announcements");
    expect(result.content).toContain("#random");
    expect(env.mock.conversations.list).toHaveBeenCalledWith({
      types: "public_channel",
      limit: 200,
      exclude_archived: true,
    });
  });

  it("includes private channels when requested", async () => {
    const channels: SlackConversationLike[] = [
      { id: "C9", name: "secrets", is_private: true },
    ];
    env.mock.conversations.list.mockResolvedValue({ ok: true, channels });
    const tool = createListChannelsTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ include_private: true }),
      ctx,
    );
    expect(result.content).toContain("[private]");
    expect(env.mock.conversations.list).toHaveBeenCalledWith({
      types: "public_channel,private_channel",
      limit: 200,
      exclude_archived: true,
    });
  });

  it("flags archived channels", async () => {
    const channels: SlackConversationLike[] = [
      { id: "C1", name: "old", is_archived: true },
    ];
    env.mock.conversations.list.mockResolvedValue({ ok: true, channels });
    const tool = createListChannelsTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ exclude_archived: false }),
      ctx,
    );
    expect(result.content).toContain("[archived]");
  });

  it("reports no channels", async () => {
    env.mock.conversations.list.mockResolvedValue({ ok: true, channels: [] });
    const tool = createListChannelsTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("No channels");
  });

  it("returns is_error on auth failure", async () => {
    env.mock.conversations.list.mockRejectedValue(slackErr("invalid_auth"));
    const tool = createListChannelsTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("authentication failed");
  });
});

// ---------------------------------------------------------------------------
// list_members
// ---------------------------------------------------------------------------

describe("list_members", () => {
  it("formats members and filters bots/deleted by default", async () => {
    const members: SlackUserLike[] = [
      { id: "U1", name: "alice", real_name: "Alice Smith" },
      { id: "U2", name: "bobby", is_bot: true },
      { id: "U3", name: "charlie", deleted: true },
    ];
    env.mock.users.list.mockResolvedValue({ ok: true, members });
    const tool = createListMembersTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("1 member");
    expect(result.content).toContain("@alice");
    expect(result.content).toContain("Alice Smith");
    expect(result.content).not.toContain("@bobby");
    expect(result.content).not.toContain("@charlie");
  });

  it("includes bots/deleted when asked", async () => {
    const members: SlackUserLike[] = [
      { id: "U1", name: "alice" },
      { id: "U2", name: "bobby", is_bot: true },
      { id: "U3", name: "charlie", deleted: true },
    ];
    env.mock.users.list.mockResolvedValue({ ok: true, members });
    const tool = createListMembersTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ include_bots: true, include_deleted: true }),
      ctx,
    );
    expect(result.content).toContain("3 members");
    expect(result.content).toContain("[bot]");
    expect(result.content).toContain("[deleted]");
  });

  it("reports empty results", async () => {
    env.mock.users.list.mockResolvedValue({ ok: true, members: [] });
    const tool = createListMembersTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("No matching members");
  });

  it("returns is_error on API failure", async () => {
    env.mock.users.list.mockRejectedValue(slackErr("ratelimited"));
    const tool = createListMembersTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("rate limit");
  });
});

// ---------------------------------------------------------------------------
// send_dm
// ---------------------------------------------------------------------------

describe("send_dm", () => {
  it("opens a DM and posts a message", async () => {
    env.mock.conversations.open.mockResolvedValue({
      ok: true,
      channel: { id: "D1" },
    });
    env.mock.chat.postMessage.mockResolvedValue({
      ok: true,
      ts: "1700000000.700",
      channel: "D1",
    });
    const tool = createSendDmTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ user: "U9", text: "hi!" }),
      ctx,
    );
    expect(result.content).toContain("Sent DM 1700000000.700 to U9");
    expect(env.mock.conversations.open).toHaveBeenCalledWith({ users: "U9" });
    expect(env.mock.chat.postMessage).toHaveBeenCalledWith({
      channel: "D1",
      text: "hi!",
    });
  });

  it("returns is_error when conversations.open returns no channel id", async () => {
    env.mock.conversations.open.mockResolvedValue({ ok: true, channel: undefined });
    const tool = createSendDmTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ user: "U9", text: "x" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("no channel id");
  });

  it("returns is_error when postMessage returns no ts", async () => {
    env.mock.conversations.open.mockResolvedValue({
      ok: true,
      channel: { id: "D1" },
    });
    env.mock.chat.postMessage.mockResolvedValue({ ok: true });
    const tool = createSendDmTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ user: "U9", text: "x" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("no ts");
  });

  it("returns is_error when conversations.open rejects", async () => {
    env.mock.conversations.open.mockRejectedValue(slackErr("user_not_found"));
    const tool = createSendDmTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ user: "UX", text: "x" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("User not found");
  });
});

// ---------------------------------------------------------------------------
// search_messages
// ---------------------------------------------------------------------------

describe("search_messages", () => {
  it("filters the scan window to case-insensitive substring matches", async () => {
    env.mock.conversations.history.mockResolvedValue({
      ok: true,
      messages: [
        makeMessage({ ts: "1700000000.001", text: "Hello World" }),
        makeMessage({ ts: "1700000000.002", text: "boring" }),
        makeMessage({ ts: "1700000000.003", text: "hello again" }),
      ],
    });
    const tool = createSearchMessagesTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel: "C1", query: "hello" }),
      ctx,
    );
    expect(result.content).toContain("2 matches");
    expect(result.content).toContain("1700000000.001");
    expect(result.content).toContain("1700000000.003");
    expect(result.content).not.toContain("1700000000.002");
    expect(env.mock.conversations.history).toHaveBeenCalledWith({
      channel: "C1",
      limit: 200,
    });
  });

  it("truncates by the user-supplied limit after filtering", async () => {
    const messages: SlackMessageLike[] = [];
    for (let i = 1; i <= 5; i++) {
      messages.push(makeMessage({ ts: `1700000000.${i}`, text: `match ${i}` }));
    }
    env.mock.conversations.history.mockResolvedValue({ ok: true, messages });
    const tool = createSearchMessagesTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel: "C1", query: "match", limit: 2 }),
      ctx,
    );
    expect(result.content).toContain("2 matches");
  });

  it("reports no matches", async () => {
    env.mock.conversations.history.mockResolvedValue({
      ok: true,
      messages: [makeMessage({ text: "xyz" })],
    });
    const tool = createSearchMessagesTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel: "C1", query: "abc" }),
      ctx,
    );
    expect(result.content).toContain("No matches");
  });

  it("treats messages without text as no-match", async () => {
    // `text` explicitly omitted to exercise the `m.text ?? ""` guard.
    env.mock.conversations.history.mockResolvedValue({
      ok: true,
      messages: [{ ts: "1700000000.001", user: "U1", type: "message" }],
    });
    const tool = createSearchMessagesTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ channel: "C1", query: "hello" }),
      ctx,
    );
    expect(result.content).toContain("No matches");
  });
});

// ---------------------------------------------------------------------------
// get_workspace_info
// ---------------------------------------------------------------------------

describe("get_workspace_info", () => {
  it("returns name, id, domain and icon", async () => {
    const team: SlackTeamLike = {
      id: "T1",
      name: "Cool Co",
      domain: "coolco",
      email_domain: "coolco.com",
      icon: { image_132: "https://cdn/icon-132.png" },
    };
    env.mock.team.info.mockResolvedValue({ ok: true, team });
    const tool = createGetWorkspaceInfoTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("Cool Co (T1)");
    expect(result.content).toContain("coolco.slack.com");
    expect(result.content).toContain("coolco.com");
    expect(result.content).toContain("Icon: https://cdn/icon-132.png");
  });

  it("falls back to smaller icon sizes", async () => {
    const team: SlackTeamLike = {
      id: "T1",
      name: "Tiny Co",
      icon: { image_44: "https://cdn/icon-44.png" },
    };
    env.mock.team.info.mockResolvedValue({ ok: true, team });
    const tool = createGetWorkspaceInfoTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("https://cdn/icon-44.png");
  });

  it("omits the icon line when none is provided", async () => {
    const team: SlackTeamLike = { id: "T1", name: "No Icon Co" };
    env.mock.team.info.mockResolvedValue({ ok: true, team });
    const tool = createGetWorkspaceInfoTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).not.toContain("Icon:");
  });

  it("returns is_error when Slack returns no team", async () => {
    env.mock.team.info.mockResolvedValue({ ok: true, team: undefined });
    const tool = createGetWorkspaceInfoTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("no team info");
  });

  it("returns is_error on API failure", async () => {
    env.mock.team.info.mockRejectedValue(slackErr("invalid_auth"));
    const tool = createGetWorkspaceInfoTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("authentication failed");
  });
});

// ---------------------------------------------------------------------------
// format utilities
// ---------------------------------------------------------------------------

describe("format utilities", () => {
  it("slackErrorMessage maps every documented error code", () => {
    expect(slackErrorMessage(slackErr("not_authed"))).toContain("authentication failed");
    expect(slackErrorMessage(slackErr("invalid_auth"))).toContain("authentication failed");
    expect(
      slackErrorMessage(
        Object.assign(new Error("x"), {
          data: { error: "missing_scope", needed: "chat:write" },
        }),
      ),
    ).toContain("chat:write");
    expect(slackErrorMessage(slackErr("channel_not_found"))).toContain("Channel not found");
    expect(slackErrorMessage(slackErr("user_not_found"))).toContain("User not found");
    expect(slackErrorMessage(slackErr("not_in_channel"))).toContain("Bot is not in the channel");
    expect(slackErrorMessage(slackErr("message_not_found"))).toContain("Message not found");
    expect(slackErrorMessage(slackErr("cant_update_message"))).toContain(
      "Bots can only edit messages they posted",
    );
    expect(slackErrorMessage(slackErr("cant_delete_message"))).toContain(
      "Bots can only delete messages they posted",
    );
    expect(slackErrorMessage(slackErr("ratelimited"))).toContain("rate limit");
    expect(slackErrorMessage(slackErr("msg_too_long"))).toContain("too long");
    expect(slackErrorMessage(slackErr("is_archived"))).toContain("archived");
    expect(slackErrorMessage(slackErr("no_text"))).toContain("empty message");
  });

  it("slackErrorMessage falls back to slack code for unknown codes", () => {
    expect(slackErrorMessage(slackErr("some_new_error"))).toContain("some_new_error");
  });

  it("slackErrorMessage handles a generic Error without slack data", () => {
    expect(slackErrorMessage(new Error("boom"))).toContain("boom");
  });

  it("slackErrorMessage handles non-Error input", () => {
    expect(slackErrorMessage("string error")).toBe("string error");
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

  it("tsToDate parses fractional seconds", () => {
    const d = tsToDate("1700000000.500000");
    expect(d.getTime()).toBe(1_700_000_000_500);
  });

  it("formatTs returns ISO for valid ts", () => {
    expect(formatTs("1700000000.000000")).toBe(
      new Date(1_700_000_000_000).toISOString(),
    );
  });

  it("authorLabel prefers username, then user, then bot_id", () => {
    expect(authorLabel({ username: "alice", user: "U1", bot_id: "B1" })).toBe("alice");
    expect(authorLabel({ user: "U1", bot_id: "B1" })).toBe("U1");
    expect(authorLabel({ bot_id: "B1" })).toBe("B1");
    expect(authorLabel({})).toBe("unknown");
  });
});
