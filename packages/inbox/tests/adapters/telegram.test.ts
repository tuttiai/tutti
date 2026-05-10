import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramClientWrapper } from "@tuttiai/telegram";
import type {
  BotFactory,
  TelegramApiLike,
  TelegramBotLike,
  TelegramTextContextLike,
} from "@tuttiai/telegram";
import { TelegramInboxAdapter } from "../../src/adapters/telegram.js";
import type { InboxMessage } from "../../src/types.js";

interface MockApi extends TelegramApiLike {
  getMe: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  deleteMessage: ReturnType<typeof vi.fn>;
  sendPhoto: ReturnType<typeof vi.fn>;
}

interface MockBot extends TelegramBotLike {
  telegram: MockApi;
  on: ReturnType<typeof vi.fn>;
  launch: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  emitText: (ctx: TelegramTextContextLike) => Promise<void>;
}

function makeMockBot(): MockBot {
  let textHandler: ((c: TelegramTextContextLike) => void | Promise<void>) | undefined;
  const api: MockApi = {
    getMe: vi.fn(async () => ({ id: 1, username: "tutti_bot", is_bot: true })),
    sendMessage: vi.fn(async () => ({
      message_id: 99,
      date: 1700000000,
      chat: { id: 42 },
    })),
    editMessageText: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
    sendPhoto: vi.fn(async () => ({
      message_id: 100,
      date: 1700000000,
      chat: { id: 42 },
    })),
  };
  const on = vi.fn((_filter: "text", handler: (c: TelegramTextContextLike) => void | Promise<void>) => {
    textHandler = handler;
  });
  const bot: MockBot = {
    telegram: api,
    on: on as unknown as MockBot["on"],
    launch: vi.fn(async () => {
      await new Promise(() => {});
    }),
    stop: vi.fn(),
    emitText: async (c: TelegramTextContextLike) => {
      if (!textHandler) throw new Error("no handler");
      await textHandler(c);
    },
  };
  return bot;
}

function makeFactory(bot: TelegramBotLike): BotFactory {
  return () => bot;
}

beforeEach(() => {
  TelegramClientWrapper.cache.clear();
  delete process.env["TELEGRAM_BOT_TOKEN"];
});

afterEach(() => {
  TelegramClientWrapper.cache.clear();
});

describe("TelegramInboxAdapter", () => {
  it("rejects polling=false (webhook mode reserved)", () => {
    expect(() => new TelegramInboxAdapter({ polling: false })).toThrow(/webhook/);
  });

  it("throws when no token is configured at start()", async () => {
    const adapter = new TelegramInboxAdapter();
    await expect(adapter.start(async () => {})).rejects.toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it("registers a text dispatcher and routes inbound messages to the handler", async () => {
    const bot = makeMockBot();
    const adapter = new TelegramInboxAdapter({
      token: "tok-1",
      clientFactory: makeFactory(bot),
    });
    const received: InboxMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });
    expect(bot.telegram.getMe).toHaveBeenCalledTimes(1);
    expect(bot.launch).toHaveBeenCalledTimes(1);

    await bot.emitText({
      message: {
        message_id: 1,
        date: 1700000000,
        text: "hello",
        chat: { id: 42 },
        from: { id: 7, username: "alice" },
      },
    });
    expect(received).toEqual([
      {
        platform: "telegram",
        platform_user_id: "7",
        platform_chat_id: "42",
        text: "hello",
        timestamp: 1700000000_000,
        raw: expect.any(Object) as unknown,
      },
    ]);
  });

  it("drops messages from anonymous channel admins (no `from`)", async () => {
    const bot = makeMockBot();
    const adapter = new TelegramInboxAdapter({
      token: "tok-2",
      clientFactory: makeFactory(bot),
    });
    const received: InboxMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });
    await bot.emitText({
      message: { message_id: 1, date: 0, text: "anon", chat: { id: 1 } },
    });
    expect(received).toEqual([]);
  });

  it("send() routes to telegram.sendMessage with the right argument shape", async () => {
    const bot = makeMockBot();
    const adapter = new TelegramInboxAdapter({
      token: "tok-3",
      clientFactory: makeFactory(bot),
    });
    await adapter.start(async () => {});
    await adapter.send("42", { text: "hi" });
    expect(bot.telegram.sendMessage).toHaveBeenCalledWith(42, "hi");
    await adapter.send("@channel_username", { text: "hi" });
    expect(bot.telegram.sendMessage).toHaveBeenLastCalledWith("@channel_username", "hi");
  });

  it("send() skips empty replies", async () => {
    const bot = makeMockBot();
    const adapter = new TelegramInboxAdapter({
      token: "tok-4",
      clientFactory: makeFactory(bot),
    });
    await adapter.start(async () => {});
    await adapter.send("42", { text: "" });
    expect(bot.telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("stop() releases the wrapper ref so the cache empties", async () => {
    const bot = makeMockBot();
    const adapter = new TelegramInboxAdapter({
      token: "tok-stop",
      clientFactory: makeFactory(bot),
    });
    await adapter.start(async () => {});
    expect(TelegramClientWrapper.cache.has("tok-stop")).toBe(true);
    await adapter.stop();
    expect(TelegramClientWrapper.cache.has("tok-stop")).toBe(false);
  });

  it("start/stop are idempotent", async () => {
    const bot = makeMockBot();
    const adapter = new TelegramInboxAdapter({
      token: "tok-idem",
      clientFactory: makeFactory(bot),
    });
    await adapter.start(async () => {});
    await adapter.start(async () => {});
    await adapter.stop();
    await adapter.stop();
    expect(bot.launch).toHaveBeenCalledTimes(1);
    expect(bot.stop).toHaveBeenCalledTimes(1);
  });
});
