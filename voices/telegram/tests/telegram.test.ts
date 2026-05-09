import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@tuttiai/types";
import { TelegramVoice } from "../src/index.js";
import {
  TelegramClientWrapper,
  createTelegramClient,
  type BotFactory,
  type TelegramApiLike,
  type TelegramBotLike,
  type TelegramMessageLike,
  type TelegramTextContextLike,
} from "../src/client.js";
import { createPostMessageTool } from "../src/tools/post-message.js";
import { createEditMessageTool } from "../src/tools/edit-message.js";
import { createDeleteMessageTool } from "../src/tools/delete-message.js";
import { createSendPhotoTool } from "../src/tools/send-photo.js";
import { telegramErrorMessage, truncate } from "../src/utils/format.js";

const ctx: ToolContext = { session_id: "test", agent_name: "test" };

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
  /** Captured text-handler so tests can synthesize inbound messages. */
  emitText: (ctx: TelegramTextContextLike) => Promise<void>;
}

function makeMessage(overrides: Partial<TelegramMessageLike> = {}): TelegramMessageLike {
  return {
    message_id: overrides.message_id ?? 100,
    date: overrides.date ?? 1700000000,
    chat: overrides.chat ?? { id: 999, type: "private" },
    ...(overrides.from !== undefined ? { from: overrides.from } : {}),
    ...(overrides.text !== undefined ? { text: overrides.text } : {}),
    ...(overrides.caption !== undefined ? { caption: overrides.caption } : {}),
  };
}

function makeMockBot(): MockBot {
  let textHandler: ((c: TelegramTextContextLike) => void | Promise<void>) | undefined;
  const api: MockApi = {
    getMe: vi.fn(async () => ({ id: 1, username: "tutti_bot", is_bot: true })),
    sendMessage: vi.fn(async (chat_id: string | number) =>
      makeMessage({ message_id: 200, chat: { id: typeof chat_id === "number" ? chat_id : 999 } }),
    ),
    editMessageText: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
    sendPhoto: vi.fn(async (chat_id: string | number) =>
      makeMessage({ message_id: 300, chat: { id: typeof chat_id === "number" ? chat_id : 999 } }),
    ),
  };
  const on = vi.fn((_filter: "text", handler: (c: TelegramTextContextLike) => void | Promise<void>) => {
    textHandler = handler;
  });
  const bot: MockBot = {
    telegram: api,
    on: on as unknown as MockBot["on"],
    launch: vi.fn(async () => {
      // Simulate telegraf's never-resolving promise being fired-and-forgotten
      await new Promise(() => {});
    }),
    stop: vi.fn(),
    emitText: async (c: TelegramTextContextLike) => {
      if (!textHandler) throw new Error("No text handler registered");
      await textHandler(c);
    },
  };
  return bot;
}

function mockFactory(bot: TelegramBotLike): BotFactory {
  return () => bot;
}

beforeEach(() => {
  TelegramClientWrapper.cache.clear();
});

afterEach(() => {
  TelegramClientWrapper.cache.clear();
});

describe("TelegramClientWrapper", () => {
  describe("forToken cache + ref counting", () => {
    it("returns the same instance for the same token", () => {
      const bot = makeMockBot();
      const a = TelegramClientWrapper.forToken("tok-1", mockFactory(bot));
      const b = TelegramClientWrapper.forToken("tok-1", mockFactory(makeMockBot()));
      expect(a).toBe(b);
      expect(a._refCount).toBe(2);
    });

    it("returns distinct instances for different tokens", () => {
      const a = TelegramClientWrapper.forToken("tok-1", mockFactory(makeMockBot()));
      const b = TelegramClientWrapper.forToken("tok-2", mockFactory(makeMockBot()));
      expect(a).not.toBe(b);
    });

    it("only stops the bot when the last holder destroys", async () => {
      const bot = makeMockBot();
      const a = TelegramClientWrapper.forToken("tok-1", mockFactory(bot));
      const b = TelegramClientWrapper.forToken("tok-1", mockFactory(makeMockBot()));
      await a.launch();
      expect(bot.launch).toHaveBeenCalledTimes(1);

      await a.destroy();
      expect(bot.stop).not.toHaveBeenCalled();
      expect(TelegramClientWrapper.cache.has("tok-1")).toBe(true);

      await b.destroy();
      expect(bot.stop).toHaveBeenCalledTimes(1);
      expect(TelegramClientWrapper.cache.has("tok-1")).toBe(false);
    });

    it("standalone constructor is not cached and stops immediately", async () => {
      const bot = makeMockBot();
      const w = new TelegramClientWrapper("tok-3", mockFactory(bot));
      expect(TelegramClientWrapper.cache.has("tok-3")).toBe(false);
      await w.launch();
      await w.destroy();
      expect(bot.stop).toHaveBeenCalledTimes(1);
    });

    it("destroy is idempotent", async () => {
      const bot = makeMockBot();
      const w = new TelegramClientWrapper("tok-4", mockFactory(bot));
      await w.launch();
      await w.destroy();
      await w.destroy();
      expect(bot.stop).toHaveBeenCalledTimes(1);
    });
  });

  describe("launch lifecycle", () => {
    it("validates the token via getMe before launching", async () => {
      const bot = makeMockBot();
      const w = new TelegramClientWrapper("tok-1", mockFactory(bot));
      await w.launch();
      expect(bot.telegram.getMe).toHaveBeenCalledTimes(1);
      expect(bot.launch).toHaveBeenCalledTimes(1);
    });

    it("propagates getMe errors and lets the next launch retry", async () => {
      const bot = makeMockBot();
      bot.telegram.getMe.mockRejectedValueOnce(new Error("Unauthorized"));
      const w = new TelegramClientWrapper("tok-1", mockFactory(bot));
      await expect(w.launch()).rejects.toThrow("Unauthorized");
      // Second call should retry
      await w.launch();
      expect(bot.telegram.getMe).toHaveBeenCalledTimes(2);
      expect(bot.launch).toHaveBeenCalledTimes(1);
    });

    it("launch is idempotent — second call is a no-op", async () => {
      const bot = makeMockBot();
      const w = new TelegramClientWrapper("tok-1", mockFactory(bot));
      await w.launch();
      await w.launch();
      expect(bot.launch).toHaveBeenCalledTimes(1);
      expect(bot.telegram.getMe).toHaveBeenCalledTimes(1);
    });
  });

  describe("onText subscription", () => {
    it("dispatches text messages to subscribers", async () => {
      const bot = makeMockBot();
      const w = new TelegramClientWrapper("tok-1", mockFactory(bot));
      const handler = vi.fn();
      w.onText(handler);
      await bot.emitText({
        message: {
          message_id: 1,
          date: 1700000000,
          text: "hello",
          chat: { id: 42 },
          from: { id: 7 },
        },
      });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]?.[0].message.text).toBe("hello");
    });

    it("supports multiple subscribers and unsubscribe", async () => {
      const bot = makeMockBot();
      const w = new TelegramClientWrapper("tok-1", mockFactory(bot));
      const a = vi.fn();
      const b = vi.fn();
      const unsubA = w.onText(a);
      w.onText(b);
      await bot.emitText({
        message: { message_id: 1, date: 0, text: "x", chat: { id: 1 } },
      });
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
      // bot.on registered the dispatcher exactly once
      expect(bot.on).toHaveBeenCalledTimes(1);
      unsubA();
      await bot.emitText({
        message: { message_id: 2, date: 0, text: "y", chat: { id: 1 } },
      });
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(2);
    });

    it("a thrown handler does not stop other handlers", async () => {
      const bot = makeMockBot();
      const w = new TelegramClientWrapper("tok-1", mockFactory(bot));
      const a = vi.fn(() => {
        throw new Error("boom");
      });
      const b = vi.fn();
      w.onText(a);
      w.onText(b);
      await bot.emitText({
        message: { message_id: 1, date: 0, text: "x", chat: { id: 1 } },
      });
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });
  });
});

describe("createTelegramClient", () => {
  it("returns kind=missing when no token is configured", () => {
    delete process.env["TELEGRAM_BOT_TOKEN"];
    const c = createTelegramClient();
    expect(c.kind).toBe("missing");
    if (c.kind === "missing") {
      expect(c.message).toContain("TELEGRAM_BOT_TOKEN");
      expect(c.message).toContain("BotFather");
    }
  });

  it("returns kind=ready when a token is provided", () => {
    const c = createTelegramClient({
      token: "tok-A",
      clientFactory: mockFactory(makeMockBot()),
    });
    expect(c.kind).toBe("ready");
    if (c.kind === "ready") {
      expect(c.wrapper).toBeInstanceOf(TelegramClientWrapper);
    }
  });

  it("uses the shared cache so multiple clients with the same token share a bot", () => {
    const f1 = mockFactory(makeMockBot());
    const f2 = mockFactory(makeMockBot());
    const a = createTelegramClient({ token: "tok-A", clientFactory: f1 });
    const b = createTelegramClient({ token: "tok-A", clientFactory: f2 });
    if (a.kind !== "ready" || b.kind !== "ready") throw new Error("expected ready");
    expect(a.wrapper).toBe(b.wrapper);
  });
});

describe("TelegramVoice", () => {
  it("registers four destructive tools", () => {
    const voice = new TelegramVoice({
      token: "tok-V",
      clientFactory: mockFactory(makeMockBot()),
    });
    expect(voice.name).toBe("telegram");
    expect(voice.required_permissions).toEqual(["network"]);
    const names = voice.tools.map((t) => t.name).sort();
    expect(names).toEqual(["delete_message", "edit_message", "post_message", "send_photo"]);
    for (const t of voice.tools) {
      expect(t.destructive).toBe(true);
    }
  });

  it("teardown decrements the cache ref count", async () => {
    const bot = makeMockBot();
    const voice = new TelegramVoice({ token: "tok-V2", clientFactory: mockFactory(bot) });
    expect(TelegramClientWrapper.cache.has("tok-V2")).toBe(true);
    await voice.teardown();
    expect(TelegramClientWrapper.cache.has("tok-V2")).toBe(false);
  });
});

describe("tools", () => {
  function makeVoiceClient(): { client: ReturnType<typeof createTelegramClient>; bot: MockBot } {
    const bot = makeMockBot();
    const client = createTelegramClient({ token: "tools-tok", clientFactory: mockFactory(bot) });
    return { client, bot };
  }

  describe("post_message", () => {
    it("sends and reports the new message id", async () => {
      const { client, bot } = makeVoiceClient();
      const tool = createPostMessageTool(client);
      const res = await tool.execute({ chat_id: 42, text: "hi" }, ctx);
      expect(res.is_error).toBeUndefined();
      expect(res.content).toContain("Posted message 200");
      expect(bot.telegram.sendMessage).toHaveBeenCalledWith(42, "hi", {});
    });

    it("forwards parse_mode and reply_to_message_id when provided", async () => {
      const { client, bot } = makeVoiceClient();
      const tool = createPostMessageTool(client);
      await tool.execute(
        {
          chat_id: "@chan",
          text: "hi",
          parse_mode: "HTML",
          reply_to_message_id: 7,
        },
        ctx,
      );
      expect(bot.telegram.sendMessage).toHaveBeenCalledWith("@chan", "hi", {
        parse_mode: "HTML",
        reply_to_message_id: 7,
      });
    });

    it("returns is_error=true on telegram failure", async () => {
      const { client, bot } = makeVoiceClient();
      bot.telegram.sendMessage.mockRejectedValueOnce({
        code: 403,
        description: "Forbidden: bot was blocked by the user",
      });
      const tool = createPostMessageTool(client);
      const res = await tool.execute({ chat_id: 42, text: "hi" }, ctx);
      expect(res.is_error).toBe(true);
      expect(res.content).toContain("[403]");
      expect(res.content).toContain("blocked by the user");
    });

    it("returns kind=missing message when the client is unconfigured", async () => {
      delete process.env["TELEGRAM_BOT_TOKEN"];
      const client = createTelegramClient();
      const tool = createPostMessageTool(client);
      const res = await tool.execute({ chat_id: 1, text: "hi" }, ctx);
      expect(res.is_error).toBe(true);
      expect(res.content).toContain("TELEGRAM_BOT_TOKEN");
    });
  });

  describe("edit_message", () => {
    it("calls editMessageText with undefined inline id", async () => {
      const { client, bot } = makeVoiceClient();
      const tool = createEditMessageTool(client);
      const res = await tool.execute({ chat_id: 1, message_id: 5, text: "new" }, ctx);
      expect(res.is_error).toBeUndefined();
      expect(bot.telegram.editMessageText).toHaveBeenCalledWith(1, 5, undefined, "new", {});
    });
  });

  describe("delete_message", () => {
    it("delegates to deleteMessage", async () => {
      const { client, bot } = makeVoiceClient();
      const tool = createDeleteMessageTool(client);
      const res = await tool.execute({ chat_id: 1, message_id: 9 }, ctx);
      expect(res.is_error).toBeUndefined();
      expect(bot.telegram.deleteMessage).toHaveBeenCalledWith(1, 9);
    });
  });

  describe("send_photo", () => {
    it("forwards a URL and reports the new message id", async () => {
      const { client, bot } = makeVoiceClient();
      const tool = createSendPhotoTool(client);
      const res = await tool.execute(
        { chat_id: 1, photo: "https://example.com/p.jpg", caption: "hi" },
        ctx,
      );
      expect(res.is_error).toBeUndefined();
      expect(res.content).toContain("Sent photo as message 300");
      expect(bot.telegram.sendPhoto).toHaveBeenCalledWith(1, "https://example.com/p.jpg", {
        caption: "hi",
      });
    });
  });
});

describe("format helpers", () => {
  it("telegramErrorMessage formats telegraf-style errors with code + description", () => {
    expect(
      telegramErrorMessage({ code: 400, description: "Bad Request" }, "chat 42"),
    ).toBe("Telegram error [400] for chat 42: Bad Request");
  });

  it("telegramErrorMessage falls back to message", () => {
    expect(telegramErrorMessage(new Error("nope"), "x")).toContain("nope");
  });

  it("truncate respects max length", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("abcdefghijklmnop", 5)).toBe("abcd…");
  });
});
