import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "@tuttiai/core";
import type { TuttiRuntime } from "@tuttiai/core";
import type { AgentResult, TuttiEvent } from "@tuttiai/types";

import { DiscordClientWrapper } from "@tuttiai/discord";
import type {
  ClientFactory as DiscordClientFactory,
  DiscordClientLike,
  DiscordMessageLike,
  DiscordTextChannelLike,
} from "@tuttiai/discord";

import { SlackClientWrapper } from "@tuttiai/slack";
import type {
  ClientFactory as SlackClientFactory,
  SlackClientLike,
  SlackEventEnvelope,
  SocketModeClientLike,
  SocketModeFactory,
} from "@tuttiai/slack";

import { TelegramClientWrapper } from "@tuttiai/telegram";
import type {
  BotFactory as TelegramBotFactory,
  TelegramApiLike,
  TelegramBotLike,
  TelegramTextContextLike,
} from "@tuttiai/telegram";

import { WhatsAppClientWrapper } from "@tuttiai/whatsapp";
import type { FetchLike as WhatsAppFetchLike } from "@tuttiai/whatsapp";
import { createHmac } from "node:crypto";

import { TuttiInbox } from "../../src/inbox.js";
import {
  TelegramInboxAdapter,
  SlackInboxAdapter,
  DiscordInboxAdapter,
  WhatsAppInboxAdapter,
  InMemoryIdentityStore,
  identityKey,
} from "../../src/index.js";

// ---------------------------------------------------------------------------
// Runtime stub
// ---------------------------------------------------------------------------

function makeRuntime(): {
  runtime: TuttiRuntime;
  events: EventBus;
  run: ReturnType<typeof vi.fn>;
} {
  const events = new EventBus();
  let call = 0;
  const run = vi.fn(
    async (
      _agent: string,
      input: string,
      session_id?: string,
    ): Promise<AgentResult> => {
      const idx = call++;
      return {
        session_id: session_id ?? `sess-${idx + 1}`,
        output: `agent saw: ${input}`,
        messages: [],
        turns: 1,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    },
  );
  return { runtime: { events, run } as unknown as TuttiRuntime, events, run };
}

function captureEvents(events: EventBus): TuttiEvent[] {
  const captured: TuttiEvent[] = [];
  events.onAny((e) => captured.push(e));
  return captured;
}

async function flush(times: number = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------
// Telegram mock plumbing
// ---------------------------------------------------------------------------

interface MockTelegramApi extends TelegramApiLike {
  getMe: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  deleteMessage: ReturnType<typeof vi.fn>;
  sendPhoto: ReturnType<typeof vi.fn>;
}

interface MockTelegramBot extends TelegramBotLike {
  telegram: MockTelegramApi;
  on: ReturnType<typeof vi.fn>;
  launch: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  emitText: (ctx: TelegramTextContextLike) => Promise<void>;
}

function makeTelegramBot(): MockTelegramBot {
  let handler: ((c: TelegramTextContextLike) => void | Promise<void>) | undefined;
  return {
    telegram: {
      getMe: vi.fn(async () => ({ id: 1, is_bot: true, username: "tutti_bot" })),
      sendMessage: vi.fn(async () => ({
        message_id: 1,
        date: 1700000000,
        chat: { id: 1 },
      })),
      editMessageText: vi.fn(async () => true),
      deleteMessage: vi.fn(async () => true),
      sendPhoto: vi.fn(async () => ({
        message_id: 2,
        date: 1700000000,
        chat: { id: 1 },
      })),
    },
    on: vi.fn((_e: "text", h: (c: TelegramTextContextLike) => void | Promise<void>) => {
      handler = h;
    }) as unknown as MockTelegramBot["on"],
    launch: vi.fn(async () => {
      await new Promise(() => {});
    }),
    stop: vi.fn(),
    emitText: async (ctx) => {
      if (!handler) throw new Error("no telegram text handler");
      await handler(ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// Slack mock plumbing
// ---------------------------------------------------------------------------

interface MockSlackWeb extends SlackClientLike {
  chat: SlackClientLike["chat"] & { postMessage: ReturnType<typeof vi.fn> };
}

function makeSlackWeb(): MockSlackWeb {
  return {
    chat: {
      postMessage: vi.fn(async () => ({ ok: true, ts: "1.2", channel: "C1" })),
      update: vi.fn(async () => ({ ok: true })),
      delete: vi.fn(async () => ({ ok: true })),
      getPermalink: vi.fn(async () => ({ ok: true })),
    },
    reactions: { add: vi.fn(async () => ({ ok: true })) },
    conversations: {
      history: vi.fn(),
      list: vi.fn(),
      info: vi.fn(),
      open: vi.fn(),
    },
    users: { list: vi.fn(), info: vi.fn() },
    team: { info: vi.fn() },
  } as unknown as MockSlackWeb;
}

interface MockSlackSocket extends SocketModeClientLike {
  on: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  emit: (env: SlackEventEnvelope) => Promise<void>;
}

function makeSlackSocket(): MockSlackSocket {
  let listener:
    | ((env: SlackEventEnvelope) => void | Promise<void>)
    | undefined;
  return {
    on: vi.fn(
      (e: "slack_event", l: (env: SlackEventEnvelope) => void | Promise<void>) => {
        if (e === "slack_event") listener = l;
      },
    ) as unknown as MockSlackSocket["on"],
    start: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    emit: async (env) => {
      if (!listener) throw new Error("no slack listener");
      await listener(env);
    },
  };
}

// ---------------------------------------------------------------------------
// Discord mock plumbing
// ---------------------------------------------------------------------------

interface MockDiscordChannel extends DiscordTextChannelLike {
  send: ReturnType<typeof vi.fn>;
}

interface MockDiscordClient extends DiscordClientLike {
  channels: { fetch: ReturnType<typeof vi.fn> };
  guilds: { fetch: ReturnType<typeof vi.fn> };
  users: { fetch: ReturnType<typeof vi.fn> };
  on: ReturnType<typeof vi.fn>;
  login: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  emitMessage: (msg: DiscordMessageLike) => Promise<void>;
}

function makeDiscordClient(): { client: MockDiscordClient; channel: MockDiscordChannel } {
  const channel: MockDiscordChannel = {
    id: "Cd1",
    name: "general",
    guildId: null,
    send: vi.fn(async () => ({})),
    messages: { fetch: vi.fn() } as unknown as MockDiscordChannel["messages"],
  };
  let listener: ((m: DiscordMessageLike) => void | Promise<void>) | undefined;
  const client: MockDiscordClient = {
    channels: {
      fetch: vi.fn(async (id: string) => (id === channel.id ? channel : null)),
    },
    guilds: { fetch: vi.fn() },
    users: { fetch: vi.fn() },
    destroy: vi.fn(async () => undefined),
    login: vi.fn(async () => "ok"),
    on: vi.fn(
      (e: "messageCreate", l: (m: DiscordMessageLike) => void | Promise<void>) => {
        if (e === "messageCreate") listener = l;
      },
    ) as unknown as MockDiscordClient["on"],
    emitMessage: async (msg) => {
      if (!listener) throw new Error("no discord listener");
      await listener(msg);
    },
  };
  return { client, channel };
}

function makeDiscordMessage(
  overrides: Partial<DiscordMessageLike> & { author?: Partial<DiscordMessageLike["author"]> } = {},
): DiscordMessageLike {
  return {
    id: overrides.id ?? "dm1",
    channelId: overrides.channelId ?? "Cd1",
    guildId: overrides.guildId ?? null,
    content: overrides.content ?? "hello discord",
    createdTimestamp: overrides.createdTimestamp ?? 1_700_000_000_300,
    editedTimestamp: overrides.editedTimestamp ?? null,
    author: {
      id: overrides.author?.id ?? "Du1",
      username: overrides.author?.username ?? "carol",
      bot: overrides.author?.bot ?? false,
    },
    edit: vi.fn(),
    delete: vi.fn(),
    react: vi.fn(),
  } as DiscordMessageLike;
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  TelegramClientWrapper.cache.clear();
  SlackClientWrapper.cache.clear();
  DiscordClientWrapper.cache.clear();
  WhatsAppClientWrapper.cache.clear();
  delete process.env["TELEGRAM_BOT_TOKEN"];
  delete process.env["SLACK_BOT_TOKEN"];
  delete process.env["SLACK_APP_TOKEN"];
  delete process.env["DISCORD_BOT_TOKEN"];
  delete process.env["WHATSAPP_ACCESS_TOKEN"];
  delete process.env["WHATSAPP_VERIFY_TOKEN"];
  delete process.env["WHATSAPP_APP_SECRET"];
});

afterEach(() => {
  TelegramClientWrapper.cache.clear();
  SlackClientWrapper.cache.clear();
  DiscordClientWrapper.cache.clear();
  WhatsAppClientWrapper.cache.clear();
});

function signWhatsAppBody(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

// ---------------------------------------------------------------------------
// The integration test
// ---------------------------------------------------------------------------

describe("multi-platform inbox", () => {
  it("routes one inbound message from each platform through runtime.run and ships replies via the right adapter", async () => {
    const tgBot = makeTelegramBot();
    const slackWeb = makeSlackWeb();
    const slackSocket = makeSlackSocket();
    const { client: discordClient, channel: discordChannel } = makeDiscordClient();

    const tgFactory: TelegramBotFactory = () => tgBot;
    const slackClientFactory: SlackClientFactory = () => slackWeb;
    const slackSocketFactory: SocketModeFactory = () => slackSocket;
    const discordFactory: DiscordClientFactory = () => discordClient;

    const tgAdapter = new TelegramInboxAdapter({
      token: "tok-tg",
      clientFactory: tgFactory,
    });
    const slackAdapter = new SlackInboxAdapter({
      botToken: "xoxb-mp",
      appToken: "xapp-mp",
      clientFactory: slackClientFactory,
      socketModeFactory: slackSocketFactory,
    });
    const discordAdapter = new DiscordInboxAdapter({
      token: "tok-dc",
      clientFactory: discordFactory,
    });

    const { runtime, events, run } = makeRuntime();
    const captured = captureEvents(events);
    const inbox = new TuttiInbox(runtime, {
      agent: "support",
      adapters: [tgAdapter, slackAdapter, discordAdapter],
    });
    await inbox.start();

    // Telegram message
    await tgBot.emitText({
      message: {
        message_id: 1,
        date: 1_700_000_000,
        text: "hi from tg",
        chat: { id: 9001 },
        from: { id: 5 },
      },
    });
    // Slack message
    await slackSocket.emit({
      envelope_id: "env-slack",
      body: {
        type: "events_api",
        team_id: "T1",
        event: {
          type: "message",
          user: "U7",
          channel: "C99",
          text: "hi from slack",
          ts: "1700000000.500",
        },
      },
      ack: vi.fn(async () => undefined),
    });
    // Discord message
    await discordClient.emitMessage(makeDiscordMessage({ content: "hi from discord" }));

    await flush(8);

    // All three runs reached the agent.
    expect(run).toHaveBeenCalledTimes(3);
    const inputs = run.mock.calls.map((call) => call[1]);
    expect(inputs.sort()).toEqual(["hi from discord", "hi from slack", "hi from tg"]);

    // Each reply went out through the right adapter.
    expect(tgBot.telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(slackWeb.chat.postMessage).toHaveBeenCalledWith({
      channel: "C99",
      text: "agent saw: hi from slack",
    });
    expect(discordChannel.send).toHaveBeenCalledWith("agent saw: hi from discord");

    // Three platform-tagged received events were emitted.
    const receivedEvents = captured.filter((e) => e.type === "inbox:message_received");
    const platforms = new Set(
      receivedEvents.flatMap((e) =>
        e.type === "inbox:message_received" ? [e.platform] : [],
      ),
    );
    expect(platforms).toEqual(new Set(["telegram", "slack", "discord"]));

    await inbox.stop();
  });

  it("identityStore.link merges sessions across platforms — Slack message after a Telegram one continues the same Tutti session", async () => {
    const tgBot = makeTelegramBot();
    const slackWeb = makeSlackWeb();
    const slackSocket = makeSlackSocket();

    const identityStore = new InMemoryIdentityStore();
    // The user authenticated on Telegram first and later linked their
    // Slack id — done out-of-band by application code. We simulate that
    // here with a direct link() before any messages arrive.
    await identityStore.link(
      identityKey("telegram", "5"),
      identityKey("slack", "U7"),
    );

    const tgAdapter = new TelegramInboxAdapter({
      token: "tok-tg-link",
      clientFactory: () => tgBot,
    });
    const slackAdapter = new SlackInboxAdapter({
      botToken: "xoxb-link",
      appToken: "xapp-link",
      clientFactory: () => slackWeb,
      socketModeFactory: () => slackSocket,
    });

    const { runtime, run } = makeRuntime();
    const inbox = new TuttiInbox(runtime, {
      agent: "support",
      adapters: [tgAdapter, slackAdapter],
      identityStore,
    });
    await inbox.start();

    // First the user messages from Telegram — fresh session is bound.
    await tgBot.emitText({
      message: {
        message_id: 1,
        date: 1_700_000_000,
        text: "first from telegram",
        chat: { id: 9001 },
        from: { id: 5 },
      },
    });
    await flush(5);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]).toEqual(["support", "first from telegram", undefined]);

    // The runtime stub's first call returned session_id "sess-1". The
    // inbox should have bound it to identityKey("telegram", "5").
    expect(await identityStore.resolve(identityKey("telegram", "5"))).toBe("sess-1");
    // Because telegram:5 and slack:U7 are linked, the Slack identity
    // also resolves to sess-1.
    expect(await identityStore.resolve(identityKey("slack", "U7"))).toBe("sess-1");

    // Now the same user pings from Slack — the inbox must reuse sess-1.
    await slackSocket.emit({
      envelope_id: "env-link",
      body: {
        type: "events_api",
        team_id: "T1",
        event: {
          type: "message",
          user: "U7",
          channel: "C99",
          text: "now from slack",
          ts: "1700000001.000",
        },
      },
      ack: vi.fn(async () => undefined),
    });
    await flush(5);

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]).toEqual(["support", "now from slack", "sess-1"]);

    await inbox.stop();
  });

  it("filters out a Discord bot-loop message on the same chat that just received a real message", async () => {
    // Smoke test for the loop guard in a multi-platform context — even
    // when our agent has just replied (which discord.js would echo back
    // on the same Client if we didn't filter), the inbox must drop the
    // echo because msg.author.bot is true.
    const { client, channel } = makeDiscordClient();
    const adapter = new DiscordInboxAdapter({
      token: "tok-loop",
      clientFactory: () => client,
    });
    const { runtime, run } = makeRuntime();
    const inbox = new TuttiInbox(runtime, {
      agent: "support",
      adapters: [adapter],
    });
    await inbox.start();

    await client.emitMessage(makeDiscordMessage({ id: "real" }));
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith("agent saw: hello discord");

    // Echo from the same bot — must be ignored.
    await client.emitMessage(
      makeDiscordMessage({
        id: "echo",
        author: { id: "self", username: "tutti", bot: true },
        content: "agent saw: hello discord",
      }),
    );
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledTimes(1);

    await inbox.stop();
  });

  it("routes inbound from all five platforms (telegram + slack + discord + whatsapp) through one TuttiInbox with correct platform metadata", async () => {
    const tgBot = makeTelegramBot();
    const slackWeb = makeSlackWeb();
    const slackSocket = makeSlackSocket();
    const { client: discordClient, channel: discordChannel } = makeDiscordClient();

    // WhatsApp — set env so createWhatsAppClient resolves; provide a
    // mock fetch for outbound Graph calls. Stub the wrapper's launch()
    // so it doesn't bind a real port.
    process.env["WHATSAPP_ACCESS_TOKEN"] = "wa-token";
    process.env["WHATSAPP_VERIFY_TOKEN"] = "wa-verify";
    process.env["WHATSAPP_APP_SECRET"] = "wa-secret";
    let whatsappOutbound: { url: string; body: unknown } | undefined;
    const whatsappFetch: WhatsAppFetchLike = vi.fn(async (url: string, init?: { body?: string }) => {
      whatsappOutbound = { url, body: init?.body ? JSON.parse(init.body) : undefined };
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ messages: [{ id: "wamid.MP" }] }),
        text: async () => "",
      } as Awaited<ReturnType<WhatsAppFetchLike>>;
    }) as unknown as WhatsAppFetchLike;

    const tgAdapter = new TelegramInboxAdapter({
      token: "tok-tg-mp",
      clientFactory: () => tgBot,
    });
    const slackAdapter = new SlackInboxAdapter({
      botToken: "xoxb-mp5",
      appToken: "xapp-mp5",
      clientFactory: () => slackWeb,
      socketModeFactory: () => slackSocket,
    });
    const discordAdapter = new DiscordInboxAdapter({
      token: "tok-dc-mp",
      clientFactory: () => discordClient,
    });
    const whatsappAdapter = new WhatsAppInboxAdapter({
      phoneNumberId: "PNID-MP",
      fetchFn: whatsappFetch,
    });

    // Stub WhatsApp's launch to avoid binding to port 3848 in test.
    const origLaunch = WhatsAppClientWrapper.prototype.launch;
    WhatsAppClientWrapper.prototype.launch = async function () {};

    try {
      const { runtime, run } = makeRuntime();
      const inbox = new TuttiInbox(runtime, {
        agent: "support",
        adapters: [tgAdapter, slackAdapter, discordAdapter, whatsappAdapter],
      });
      await inbox.start();

      // Telegram inbound
      await tgBot.emitText({
        message: {
          message_id: 1,
          date: 1_700_000_000,
          text: "hi from tg",
          chat: { id: 9001 },
          from: { id: 5 },
        },
      });

      // Slack inbound
      await slackSocket.emit({
        envelope_id: "env-mp5",
        body: {
          type: "events_api",
          team_id: "T1",
          event: {
            type: "message",
            user: "U7",
            channel: "C99",
            text: "hi from slack",
            ts: "1700000000.500",
          },
        },
        ack: vi.fn(async () => undefined),
      });

      // Discord inbound
      await discordClient.emitMessage(makeDiscordMessage({ content: "hi from discord" }));

      // WhatsApp inbound — POST a signed webhook through the wrapper's
      // injected Fastify instance so we don't need to bind a port.
      const whatsappWrapper = WhatsAppClientWrapper.cache.get("PNID-MP")!;
      const whatsappPayload = {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "WABA-1",
            changes: [
              {
                field: "messages",
                value: {
                  messaging_product: "whatsapp",
                  metadata: {
                    display_phone_number: "1555…",
                    phone_number_id: "PNID-MP",
                  },
                  messages: [
                    {
                      from: "14155550100",
                      id: "wamid.IN",
                      timestamp: "1700000000",
                      type: "text",
                      text: { body: "hi from whatsapp" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
      const wbody = JSON.stringify(whatsappPayload);
      const wsig = signWhatsAppBody(wbody, "wa-secret");
      const wres = await (await whatsappWrapper.whenReady()).inject({
        method: "POST",
        url: "/webhook",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": wsig,
        },
        payload: wbody,
      });
      expect(wres.statusCode).toBe(200);

      await flush(10);

      // All four runs reached the agent.
      expect(run).toHaveBeenCalledTimes(4);
      const inputs = run.mock.calls.map((call) => call[1] as string).sort();
      expect(inputs).toEqual([
        "hi from discord",
        "hi from slack",
        "hi from tg",
        "hi from whatsapp",
      ]);

      // Each reply went out through the right adapter.
      expect(tgBot.telegram.sendMessage).toHaveBeenCalledTimes(1);
      expect(slackWeb.chat.postMessage).toHaveBeenCalledWith({
        channel: "C99",
        text: "agent saw: hi from slack",
      });
      expect(discordChannel.send).toHaveBeenCalledWith("agent saw: hi from discord");
      expect(whatsappOutbound?.url).toMatch(/PNID-MP\/messages$/);
      expect(whatsappOutbound?.body).toEqual({
        messaging_product: "whatsapp",
        to: "14155550100",
        type: "text",
        text: { body: "agent saw: hi from whatsapp" },
      });

      await inbox.stop();
    } finally {
      WhatsAppClientWrapper.prototype.launch = origLaunch;
    }
  });
});
