/**
 * Unit tests for `scheduler/dispatch.ts`. We inject a stub
 * `importFn` so the test doesn't need the optional voice peer
 * dependencies actually installed — same pattern the sibling
 * `assertDeliveryVoiceInstalled` tests already use.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  deliverScheduleResult,
  deliveryTargetSummary,
  stripMarkdown,
} from "../../src/scheduler/dispatch.js";
import type { ScheduleDeliveryTarget } from "@tuttiai/types";

// ── env helpers ─────────────────────────────────────────────────────

const ENV_BACKUP: Record<string, string | undefined> = {};
const TRACKED_KEYS = [
  "SLACK_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "TUTTI_EMAIL_SMTP_HOST",
  "TUTTI_EMAIL_SMTP_PORT",
  "TUTTI_EMAIL_SMTP_USER",
  "TUTTI_EMAIL_SMTP_PASSWORD",
  "TUTTI_EMAIL_PASSWORD",
  "TUTTI_EMAIL_FROM",
  "TUTTI_EMAIL_IMAP_HOST",
  "TUTTI_EMAIL_IMAP_USER",
  "TUTTI_EMAIL_IMAP_PASSWORD",
];

beforeEach(() => {
  for (const k of TRACKED_KEYS) ENV_BACKUP[k] = process.env[k];
});

afterEach(() => {
  for (const k of TRACKED_KEYS) {
    if (ENV_BACKUP[k] === undefined) delete process.env[k];
    else process.env[k] = ENV_BACKUP[k];
  }
});

// ── tiny per-platform mock modules ──────────────────────────────────

function makeSlackMock(postMessage: ReturnType<typeof vi.fn>): unknown {
  const cache = new Map<string, unknown>();
  return {
    SlackClientWrapper: {
      cache,
      forToken: (token: string) => {
        const wrapper = {
          getClient: () => Promise.resolve({ chat: { postMessage } }),
        };
        cache.set(token, wrapper);
        return wrapper;
      },
    },
  };
}

function makeDiscordMock(send: ReturnType<typeof vi.fn>): unknown {
  const cache = new Map<string, unknown>();
  return {
    DiscordClientWrapper: {
      cache,
      forToken: (token: string) => {
        const wrapper = {
          getClient: () =>
            Promise.resolve({
              channels: { fetch: () => Promise.resolve({ send }) },
            }),
        };
        cache.set(token, wrapper);
        return wrapper;
      },
    },
  };
}

function makeTelegramMock(sendMessage: ReturnType<typeof vi.fn>): unknown {
  const cache = new Map<string, unknown>();
  return {
    TelegramClientWrapper: {
      cache,
      forToken: (token: string) => {
        const wrapper = { telegram: { sendMessage } };
        cache.set(token, wrapper);
        return wrapper;
      },
    },
  };
}

function makeEmailMock(send: ReturnType<typeof vi.fn>): unknown {
  const cache = new Map<string, unknown>();
  return {
    EmailClientWrapper: {
      cache,
      keyFor: (opts: { imap: { host: string; port: number; user: string } }) =>
        `${opts.imap.host}:${opts.imap.port}:${opts.imap.user}`,
      forKey: (key: string) => {
        const wrapper = { send };
        cache.set(key, wrapper);
        return wrapper;
      },
    },
  };
}

function makeWhatsAppMock(
  sendText: ReturnType<typeof vi.fn>,
  preload: boolean,
): unknown {
  const cache = new Map<string, unknown>();
  if (preload) cache.set("pn-1", { sendText });
  return {
    WhatsAppClientWrapper: {
      cache,
      keyFor: (opts: { phoneNumberId: string }) => opts.phoneNumberId,
      forKey: () => ({ sendText }),
    },
  };
}

// ── per-platform happy paths ────────────────────────────────────────

describe("deliverScheduleResult", () => {
  it("slack: postMessage with channel + text", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const postMessage = vi.fn().mockResolvedValue({ ok: true });
    const importFn = vi.fn().mockResolvedValue(makeSlackMock(postMessage));
    await deliverScheduleResult({
      target: { platform: "slack", channel: "#alerts" },
      content: "hi",
      importFn,
    });
    expect(importFn).toHaveBeenCalledWith("@tuttiai/slack");
    expect(postMessage).toHaveBeenCalledWith({ channel: "#alerts", text: "hi" });
  });

  it("discord: channel.send with content", async () => {
    process.env.DISCORD_BOT_TOKEN = "discord-test";
    const send = vi.fn().mockResolvedValue({ id: "m1" });
    const importFn = vi.fn().mockResolvedValue(makeDiscordMock(send));
    await deliverScheduleResult({
      target: { platform: "discord", channel_id: "123456" },
      content: "ping",
      importFn,
    });
    expect(send).toHaveBeenCalledWith("ping");
  });

  it("discord: missing channel surfaces a clear error", async () => {
    process.env.DISCORD_BOT_TOKEN = "discord-test";
    const importFn = vi.fn().mockResolvedValue({
      DiscordClientWrapper: {
        cache: new Map<string, unknown>(),
        forToken: () => ({
          getClient: () =>
            Promise.resolve({ channels: { fetch: () => Promise.resolve(null) } }),
        }),
      },
    });
    await expect(
      deliverScheduleResult({
        target: { platform: "discord", channel_id: "999" },
        content: "x",
        importFn,
      }),
    ).rejects.toThrow(/channel "999" not found/);
  });

  it("telegram: sendMessage without parse_mode when format=text", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "tg-test";
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
    const importFn = vi.fn().mockResolvedValue(makeTelegramMock(sendMessage));
    await deliverScheduleResult({
      target: { platform: "telegram", chat_id: "42" },
      content: "hi",
      importFn,
    });
    expect(sendMessage).toHaveBeenCalledWith("42", "hi");
  });

  it("telegram: sendMessage with MarkdownV2 when format=markdown", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "tg-test";
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
    const importFn = vi.fn().mockResolvedValue(makeTelegramMock(sendMessage));
    await deliverScheduleResult({
      target: { platform: "telegram", chat_id: "42" },
      content: "*bold*",
      format: "markdown",
      importFn,
    });
    expect(sendMessage).toHaveBeenCalledWith("42", "*bold*", { parse_mode: "MarkdownV2" });
  });

  it("email: send with default subject when target.subject is unset", async () => {
    process.env.TUTTI_EMAIL_SMTP_HOST = "smtp.example";
    process.env.TUTTI_EMAIL_SMTP_PORT = "587";
    process.env.TUTTI_EMAIL_SMTP_USER = "bot@example";
    process.env.TUTTI_EMAIL_SMTP_PASSWORD = "pw";
    process.env.TUTTI_EMAIL_FROM = "Bot <bot@example>";
    const send = vi.fn().mockResolvedValue({});
    const importFn = vi.fn().mockResolvedValue(makeEmailMock(send));
    await deliverScheduleResult({
      target: { platform: "email", to: "user@example" },
      content: "body",
      agentName: "report",
      importFn,
    });
    expect(send).toHaveBeenCalledOnce();
    const call = send.mock.calls[0]?.[0] as { to: string; subject: string; text: string };
    expect(call.to).toBe("user@example");
    expect(call.text).toBe("body");
    expect(call.subject).toMatch(/^report run — \d{4}-\d{2}-\d{2}T/);
  });

  it("email: target.subject is preserved when supplied", async () => {
    process.env.TUTTI_EMAIL_SMTP_HOST = "smtp.example";
    process.env.TUTTI_EMAIL_SMTP_PORT = "587";
    process.env.TUTTI_EMAIL_SMTP_USER = "bot@example";
    process.env.TUTTI_EMAIL_SMTP_PASSWORD = "pw";
    process.env.TUTTI_EMAIL_FROM = "Bot <bot@example>";
    const send = vi.fn().mockResolvedValue({});
    const importFn = vi.fn().mockResolvedValue(makeEmailMock(send));
    await deliverScheduleResult({
      target: { platform: "email", to: "user@example", subject: "Daily report" },
      content: "body",
      importFn,
    });
    const call = send.mock.calls[0]?.[0] as { subject: string };
    expect(call.subject).toBe("Daily report");
  });

  it("whatsapp (text): sendText with raw content", async () => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = "pn-1";
    const sendText = vi.fn().mockResolvedValue({});
    const importFn = vi.fn().mockResolvedValue(makeWhatsAppMock(sendText, true));
    await deliverScheduleResult({
      target: { platform: "whatsapp", phone_number: "+15555550123" },
      content: "hi",
      importFn,
    });
    expect(sendText).toHaveBeenCalledWith("+15555550123", "hi");
  });

  it("whatsapp (markdown): strips delimiters before send", async () => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = "pn-1";
    const sendText = vi.fn().mockResolvedValue({});
    const importFn = vi.fn().mockResolvedValue(makeWhatsAppMock(sendText, true));
    await deliverScheduleResult({
      target: { platform: "whatsapp", phone_number: "+15555550123" },
      content: "**important**: read `the docs`",
      format: "markdown",
      importFn,
    });
    expect(sendText).toHaveBeenCalledWith("+15555550123", "important: read the docs");
  });

  it("whatsapp: throws when the voice has not been initialised", async () => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = "pn-1";
    const sendText = vi.fn();
    const importFn = vi.fn().mockResolvedValue(makeWhatsAppMock(sendText, false));
    await expect(
      deliverScheduleResult({
        target: { platform: "whatsapp", phone_number: "+15555550123" },
        content: "x",
        importFn,
      }),
    ).rejects.toThrow(/@tuttiai\/whatsapp voice to be active/);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("voice package not installed → remediation error", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const importFn = vi
      .fn()
      .mockRejectedValue(new Error("Cannot find module '@tuttiai/slack'"));
    await expect(
      deliverScheduleResult({
        target: { platform: "slack", channel: "#c" },
        content: "x",
        importFn,
      }),
    ).rejects.toThrow(/Install @tuttiai\/slack to use scheduled delivery/);
  });

  it("propagates platform API errors so the engine can emit delivery_failed", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const postMessage = vi.fn().mockRejectedValue(new Error("channel_not_found"));
    const importFn = vi.fn().mockResolvedValue(makeSlackMock(postMessage));
    await expect(
      deliverScheduleResult({
        target: { platform: "slack", channel: "#missing" },
        content: "x",
        importFn,
      }),
    ).rejects.toThrow(/channel_not_found/);
  });
});

// ── helpers ─────────────────────────────────────────────────────────

describe("deliveryTargetSummary", () => {
  it("returns the addressing field per platform", () => {
    const cases: Array<[ScheduleDeliveryTarget, string]> = [
      [{ platform: "slack", channel: "#alerts" }, "#alerts"],
      [{ platform: "discord", channel_id: "123" }, "123"],
      [{ platform: "telegram", chat_id: "42" }, "42"],
      [{ platform: "email", to: "a@b.com" }, "a@b.com"],
      [{ platform: "whatsapp", phone_number: "+15555550123" }, "+15555550123"],
    ];
    for (const [t, expected] of cases) {
      expect(deliveryTargetSummary(t)).toBe(expected);
    }
  });
});

describe("stripMarkdown", () => {
  it("removes bold, italic, code, link, and heading delimiters", () => {
    expect(stripMarkdown("**bold** and __also bold__")).toBe("bold and also bold");
    expect(stripMarkdown("*italic* and _also italic_")).toBe("italic and also italic");
    expect(stripMarkdown("inline `code` here")).toBe("inline code here");
    expect(stripMarkdown("```\nblock\n```")).toBe("\nblock\n");
    expect(stripMarkdown("[click](https://example.com)")).toBe("click");
    expect(stripMarkdown("# heading\n## sub")).toBe("heading\nsub");
  });

  it("leaves plain text unchanged", () => {
    expect(stripMarkdown("just words.")).toBe("just words.");
  });
});
