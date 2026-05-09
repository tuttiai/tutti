import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@tuttiai/types";
import {
  EmailVoice,
  EmailClientWrapper,
  createEmailClient,
  parsedToEmailMessage,
  type EmailMessage,
  type ImapClientLike,
  type ImapFetchRange,
  type ImapMessage,
  type ParseFn,
  type ParsedMailLike,
  type SmtpSendArgs,
  type SmtpTransporterLike,
} from "../src/index.js";
import { createSendEmailTool } from "../src/tools/send-email.js";
import { createSendReplyTool } from "../src/tools/send-reply.js";
import { createListInboxTool } from "../src/tools/list-inbox.js";

const ctx: ToolContext = { session_id: "test", agent_name: "test" };

// ---------------------------------------------------------------------------
// IMAP / SMTP / parser mocks
// ---------------------------------------------------------------------------

interface MockImap extends ImapClientLike {
  connect: ReturnType<typeof vi.fn>;
  mailboxOpen: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  messageFlagsAdd: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  /** Test helper — fire the registered 'exists' listener. */
  emitExists: () => Promise<void>;
  /** Test helper — set the messages the next fetch returns. */
  setQueue: (queue: ImapMessage[]) => void;
}

function makeMockImap(): MockImap {
  let queue: ImapMessage[] = [];
  let existsListener: (() => void | Promise<void>) | undefined;
  const fetch = vi.fn((_range: ImapFetchRange, _opts: object): AsyncIterable<ImapMessage> => {
    const msgs = queue;
    queue = [];
    return {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          next(): Promise<IteratorResult<ImapMessage>> {
            if (i < msgs.length) {
              const value = msgs[i++];
              if (value === undefined) return Promise.resolve({ done: true, value: undefined });
              return Promise.resolve({ done: false, value });
            }
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };
  });
  const on = vi.fn((event: string, listener: () => void | Promise<void>) => {
    if (event === "exists") existsListener = listener;
  });
  return {
    connect: vi.fn(async () => undefined),
    mailboxOpen: vi.fn(async () => ({ path: "INBOX" })),
    fetch: fetch as unknown as MockImap["fetch"],
    messageFlagsAdd: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    on: on as unknown as MockImap["on"],
    emitExists: async () => {
      if (!existsListener) throw new Error("no exists listener");
      await existsListener();
    },
    setQueue: (q: ImapMessage[]) => {
      queue = q;
    },
  };
}

interface MockSmtp extends SmtpTransporterLike {
  sendMail: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function makeMockSmtp(): MockSmtp {
  return {
    sendMail: vi.fn(async (args: SmtpSendArgs) => ({
      messageId: `<sent-${args.to.toString()}@local>`,
      accepted: typeof args.to === "string" ? [args.to] : args.to,
      rejected: [],
    })),
    close: vi.fn(async () => undefined),
  };
}

function makeParser(parsed: Partial<ParsedMailLike>): ParseFn {
  return async () => ({ ...parsed }) as ParsedMailLike;
}

function makeImapMessage(uid: number, source: string, size?: number): ImapMessage {
  return {
    uid,
    source: Buffer.from(source, "utf8"),
    ...(size !== undefined ? { size } : { size: source.length }),
  };
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  EmailClientWrapper.cache.clear();
  delete process.env["TUTTI_EMAIL_PASSWORD"];
  delete process.env["TUTTI_EMAIL_IMAP_PASSWORD"];
  delete process.env["TUTTI_EMAIL_SMTP_PASSWORD"];
});

afterEach(() => {
  EmailClientWrapper.cache.clear();
});

const baseConn = {
  imap: { host: "imap.local", port: 993, user: "bot@local", pass: "secret" },
  smtp: { host: "smtp.local", port: 587, user: "bot@local", pass: "secret" },
  from: "Tutti Bot <bot@local>",
};

// ---------------------------------------------------------------------------
// EmailClientWrapper — IMAP IDLE dispatch + threading + filters
// ---------------------------------------------------------------------------

describe("EmailClientWrapper", () => {
  describe("subscribeMessage + IDLE dispatch", () => {
    it("opens IMAP, mailboxOpen('INBOX'), and registers an exists listener", async () => {
      const imap = makeMockImap();
      const wrapper = new EmailClientWrapper({
        ...baseConn,
        imapFactory: () => imap,
        smtpFactory: () => makeMockSmtp(),
        parser: makeParser({}),
      });
      wrapper.subscribeMessage(vi.fn());
      await wrapper.whenSubscribed();
      expect(imap.connect).toHaveBeenCalledTimes(1);
      expect(imap.mailboxOpen).toHaveBeenCalledWith("INBOX");
      expect(imap.on).toHaveBeenCalledWith("exists", expect.any(Function));
      expect(wrapper._dispatcherInstalled).toBe(true);
    });

    it("dispatches a parsed inbound message to subscribers and marks it Seen", async () => {
      const imap = makeMockImap();
      const parsed: Partial<ParsedMailLike> = {
        subject: "hello",
        from: { value: [{ address: "alice@example.com", name: "Alice" }] },
        text: "hi there",
        messageId: "<m-1@example.com>",
      };
      const wrapper = new EmailClientWrapper({
        ...baseConn,
        imapFactory: () => imap,
        smtpFactory: () => makeMockSmtp(),
        parser: makeParser(parsed),
      });
      const handler = vi.fn();
      wrapper.subscribeMessage(handler);
      await wrapper.whenSubscribed();

      // New mail arrives.
      imap.setQueue([makeImapMessage(42, "raw1")]);
      await imap.emitExists();
      // Wait for the async dispatcher to settle.
      await new Promise<void>((r) => setImmediate(r));

      expect(handler).toHaveBeenCalledTimes(1);
      const msg = handler.mock.calls[0]?.[0] as EmailMessage;
      expect(msg).toEqual(
        expect.objectContaining({
          uid: 42,
          messageId: "<m-1@example.com>",
          subject: "hello",
          text: "hi there",
          from: { address: "alice@example.com", name: "Alice" },
          references: [],
        }),
      );
      expect(imap.messageFlagsAdd).toHaveBeenCalledWith(42, ["\\Seen"], { uid: true });
    });

    it("rejects oversized inbound messages by SIZE without parsing", async () => {
      const imap = makeMockImap();
      const parser = vi.fn(makeParser({}));
      const wrapper = new EmailClientWrapper({
        ...baseConn,
        imapFactory: () => imap,
        smtpFactory: () => makeMockSmtp(),
        parser: parser as ParseFn,
        maxBodyChars: 100,
      });
      const handler = vi.fn();
      wrapper.subscribeMessage(handler);
      await wrapper.whenSubscribed();

      // size 5_000 > 100 * 2 = 200, must be skipped without parsing.
      imap.setQueue([{ uid: 7, source: Buffer.from("X"), size: 5_000 }]);
      await imap.emitExists();
      await new Promise<void>((r) => setImmediate(r));

      expect(parser).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      expect(imap.messageFlagsAdd).toHaveBeenCalledWith(7, ["\\Seen"], { uid: true });
    });

    it("rejects oversized inbound text after parsing", async () => {
      const imap = makeMockImap();
      const longText = "x".repeat(2_000);
      const parser = makeParser({
        subject: "big",
        from: { value: [{ address: "spam@example.com" }] },
        text: longText,
        messageId: "<big-1@example.com>",
      });
      const wrapper = new EmailClientWrapper({
        ...baseConn,
        imapFactory: () => imap,
        smtpFactory: () => makeMockSmtp(),
        parser,
        maxBodyChars: 1_000,
      });
      const handler = vi.fn();
      wrapper.subscribeMessage(handler);
      await wrapper.whenSubscribed();

      imap.setQueue([makeImapMessage(99, "x", 1_500)]);
      await imap.emitExists();
      await new Promise<void>((r) => setImmediate(r));

      expect(handler).not.toHaveBeenCalled();
      expect(imap.messageFlagsAdd).toHaveBeenCalledWith(99, ["\\Seen"], { uid: true });
    });

    it("redacts secrets in the dispatched text by default", async () => {
      const imap = makeMockImap();
      const parsed: Partial<ParsedMailLike> = {
        subject: "key",
        from: { value: [{ address: "alice@example.com" }] },
        text: "here it is: sk-1234567890abcdefghijklmnopqr",
        messageId: "<m-redact@example.com>",
      };
      const wrapper = new EmailClientWrapper({
        ...baseConn,
        imapFactory: () => imap,
        smtpFactory: () => makeMockSmtp(),
        parser: makeParser(parsed),
      });
      const handler = vi.fn();
      wrapper.subscribeMessage(handler);
      await wrapper.whenSubscribed();

      imap.setQueue([makeImapMessage(101, "raw")]);
      await imap.emitExists();
      await new Promise<void>((r) => setImmediate(r));

      const msg = handler.mock.calls[0]?.[0] as EmailMessage;
      expect(msg.text).not.toContain("sk-1234567890abcdefghijklmnopqr");
    });

    it("opt-out: redactRawText=false leaves the body untouched", async () => {
      const imap = makeMockImap();
      const parsed: Partial<ParsedMailLike> = {
        subject: "key",
        from: { value: [{ address: "alice@example.com" }] },
        text: "here it is: sk-1234567890abcdefghijklmnopqr",
        messageId: "<m-redact-opt@example.com>",
      };
      const wrapper = new EmailClientWrapper({
        ...baseConn,
        imapFactory: () => imap,
        smtpFactory: () => makeMockSmtp(),
        parser: makeParser(parsed),
        redactRawText: false,
      });
      const handler = vi.fn();
      wrapper.subscribeMessage(handler);
      await wrapper.whenSubscribed();

      imap.setQueue([makeImapMessage(102, "raw")]);
      await imap.emitExists();
      await new Promise<void>((r) => setImmediate(r));

      const msg = handler.mock.calls[0]?.[0] as EmailMessage;
      expect(msg.text).toContain("sk-1234567890abcdefghijklmnopqr");
    });

    it("drops messages with no parseable from / messageId and marks them Seen", async () => {
      const imap = makeMockImap();
      const parsed: Partial<ParsedMailLike> = {
        subject: "anonymous",
        text: "no from",
        messageId: "<m-anon@example.com>",
      };
      const wrapper = new EmailClientWrapper({
        ...baseConn,
        imapFactory: () => imap,
        smtpFactory: () => makeMockSmtp(),
        parser: makeParser(parsed),
      });
      const handler = vi.fn();
      wrapper.subscribeMessage(handler);
      await wrapper.whenSubscribed();
      imap.setQueue([makeImapMessage(50, "raw")]);
      await imap.emitExists();
      await new Promise<void>((r) => setImmediate(r));
      expect(handler).not.toHaveBeenCalled();
      expect(imap.messageFlagsAdd).toHaveBeenCalledWith(50, ["\\Seen"], { uid: true });
    });

    it("a thrown handler does not break the dispatcher loop", async () => {
      const imap = makeMockImap();
      const wrapper = new EmailClientWrapper({
        ...baseConn,
        imapFactory: () => imap,
        smtpFactory: () => makeMockSmtp(),
        parser: makeParser({
          subject: "ok",
          from: { value: [{ address: "alice@example.com" }] },
          text: "hi",
          messageId: "<m-ok@example.com>",
        }),
      });
      const a = vi.fn(() => {
        throw new Error("boom");
      });
      const b = vi.fn();
      wrapper.subscribeMessage(a);
      wrapper.subscribeMessage(b);
      await wrapper.whenSubscribed();
      imap.setQueue([makeImapMessage(60, "raw")]);
      await imap.emitExists();
      await new Promise<void>((r) => setImmediate(r));
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it("drains UNSEEN messages on first subscription (catch-up after offline)", async () => {
      const imap = makeMockImap();
      // Queue up two messages BEFORE subscribeMessage — the dispatcher
      // should drain them on install rather than waiting for an
      // `exists` push.
      imap.setQueue([
        makeImapMessage(1, "raw1"),
        makeImapMessage(2, "raw2"),
      ]);
      const wrapper = new EmailClientWrapper({
        ...baseConn,
        imapFactory: () => imap,
        smtpFactory: () => makeMockSmtp(),
        parser: makeParser({
          subject: "hi",
          from: { value: [{ address: "alice@example.com" }] },
          text: "hi",
          messageId: "<m-x@example.com>",
        }),
      });
      const handler = vi.fn();
      wrapper.subscribeMessage(handler);
      await wrapper.whenSubscribed();
      await new Promise<void>((r) => setImmediate(r));
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe("send (threading)", () => {
    it("forwards basic args to nodemailer", async () => {
      const imap = makeMockImap();
      const smtp = makeMockSmtp();
      const wrapper = new EmailClientWrapper({
        ...baseConn,
        imapFactory: () => imap,
        smtpFactory: () => smtp,
        parser: makeParser({}),
      });
      const info = await wrapper.send({
        to: "alice@example.com",
        subject: "Hi",
        text: "Hello",
      });
      expect(smtp.sendMail).toHaveBeenCalledWith({
        from: "Tutti Bot <bot@local>",
        to: "alice@example.com",
        subject: "Hi",
        text: "Hello",
      });
      expect(info.messageId).toBeDefined();
    });

    it("sets In-Reply-To and References for threaded replies", async () => {
      const imap = makeMockImap();
      const smtp = makeMockSmtp();
      const wrapper = new EmailClientWrapper({
        ...baseConn,
        imapFactory: () => imap,
        smtpFactory: () => smtp,
        parser: makeParser({}),
      });
      await wrapper.send({
        to: "alice@example.com",
        subject: "Re: Hi",
        text: "Hi back",
        inReplyTo: "<original-1@example.com>",
        references: ["<root-0@example.com>", "<original-1@example.com>"],
      });
      expect(smtp.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          inReplyTo: "<original-1@example.com>",
          references: ["<root-0@example.com>", "<original-1@example.com>"],
        }),
      );
    });
  });

  describe("listMessages", () => {
    it("returns envelopes with from / subject / date / Message-ID", async () => {
      const imap = makeMockImap();
      imap.setQueue([
        {
          uid: 11,
          envelope: {
            messageId: "<m-11@example.com>",
            subject: "First",
            from: [{ address: "a@example.com", name: "A" }],
            date: new Date("2026-01-15T00:00:00Z"),
          },
        },
        {
          uid: 12,
          envelope: {
            messageId: "<m-12@example.com>",
            subject: "Second",
            from: [{ address: "b@example.com" }],
            date: new Date("2026-01-16T00:00:00Z"),
          },
        },
      ]);
      const wrapper = new EmailClientWrapper({
        ...baseConn,
        imapFactory: () => imap,
        smtpFactory: () => makeMockSmtp(),
        parser: makeParser({}),
      });
      const list = await wrapper.listMessages({ limit: 5, unseenOnly: true });
      expect(list).toHaveLength(2);
      expect(list[0]).toEqual(
        expect.objectContaining({
          uid: 11,
          messageId: "<m-11@example.com>",
          subject: "First",
          from: { address: "a@example.com", name: "A" },
          unread: true,
        }),
      );
    });
  });

  describe("forKey + ref counting", () => {
    it("returns the same instance for the same key and refs only release on the last destroy", async () => {
      const imap = makeMockImap();
      const smtp = makeMockSmtp();
      const opts = {
        ...baseConn,
        imapFactory: () => imap,
        smtpFactory: () => smtp,
        parser: makeParser({}),
      };
      const a = EmailClientWrapper.forKey("k1", opts);
      const b = EmailClientWrapper.forKey("k1", opts);
      expect(a).toBe(b);
      expect(a._refCount).toBe(2);
      await a.destroy();
      expect(EmailClientWrapper.cache.has("k1")).toBe(true);
      await b.destroy();
      expect(EmailClientWrapper.cache.has("k1")).toBe(false);
    });

    it("keyFor builds a stable host:port:user key", () => {
      const k = EmailClientWrapper.keyFor({ imap: { host: "h", port: 993, user: "u@h" } });
      expect(k).toBe("h:993:u@h");
    });
  });

  describe("destroy", () => {
    it("logs out IMAP and closes SMTP on the last release", async () => {
      const imap = makeMockImap();
      const smtp = makeMockSmtp();
      const wrapper = new EmailClientWrapper({
        ...baseConn,
        imapFactory: () => imap,
        smtpFactory: () => smtp,
        parser: makeParser({}),
      });
      // Trigger SMTP creation by sending.
      await wrapper.send({ to: "x@y", subject: "s", text: "t" });
      wrapper.subscribeMessage(vi.fn());
      await wrapper.whenSubscribed();
      await wrapper.destroy();
      expect(imap.logout).toHaveBeenCalledTimes(1);
      expect(smtp.close).toHaveBeenCalledTimes(1);
    });

    it("destroy is idempotent", async () => {
      const imap = makeMockImap();
      const wrapper = new EmailClientWrapper({
        ...baseConn,
        imapFactory: () => imap,
        smtpFactory: () => makeMockSmtp(),
        parser: makeParser({}),
      });
      await wrapper.destroy();
      await wrapper.destroy();
      expect(imap.logout).toHaveBeenCalledTimes(0);
    });
  });
});

// ---------------------------------------------------------------------------
// parsedToEmailMessage — direct unit
// ---------------------------------------------------------------------------

describe("parsedToEmailMessage", () => {
  it("splits a space-separated References string into an array", () => {
    const m = parsedToEmailMessage(
      1,
      {
        from: { value: [{ address: "a@b.c" }] },
        messageId: "<x@y>",
        references: "<a@a> <b@b>  <c@c>",
      },
      false,
    );
    expect(m?.references).toEqual(["<a@a>", "<b@b>", "<c@c>"]);
  });

  it("preserves an array References as-is", () => {
    const m = parsedToEmailMessage(
      1,
      {
        from: { value: [{ address: "a@b.c" }] },
        messageId: "<x@y>",
        references: ["<a@a>", "<b@b>"],
      },
      false,
    );
    expect(m?.references).toEqual(["<a@a>", "<b@b>"]);
  });

  it("returns null when from is missing", () => {
    expect(parsedToEmailMessage(1, { messageId: "<x@y>" }, false)).toBeNull();
  });

  it("returns null when messageId is missing", () => {
    expect(parsedToEmailMessage(1, { from: { value: [{ address: "a@b.c" }] } }, false)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createEmailClient — credential resolution
// ---------------------------------------------------------------------------

describe("createEmailClient", () => {
  it("returns kind=missing when no IMAP password is configured", () => {
    const c = createEmailClient({
      imap: { host: "h", port: 993, user: "u" },
      smtp: { host: "h", port: 587, user: "u" },
      from: "x",
    });
    expect(c.kind).toBe("missing");
    if (c.kind === "missing") {
      expect(c.message).toContain("IMAP");
    }
  });

  it("returns kind=missing when IMAP is set but SMTP is not", () => {
    process.env["TUTTI_EMAIL_IMAP_PASSWORD"] = "secret";
    const c = createEmailClient({
      imap: { host: "h", port: 993, user: "u" },
      smtp: { host: "h", port: 587, user: "u" },
      from: "x",
    });
    expect(c.kind).toBe("missing");
    if (c.kind === "missing") {
      expect(c.message).toContain("SMTP");
    }
  });

  it("uses TUTTI_EMAIL_PASSWORD as a shared fallback for both IMAP and SMTP", () => {
    process.env["TUTTI_EMAIL_PASSWORD"] = "shared";
    const c = createEmailClient({
      imap: { host: "h", port: 993, user: "u" },
      smtp: { host: "h", port: 587, user: "u" },
      from: "x",
      imapFactory: () => makeMockImap(),
      smtpFactory: () => makeMockSmtp(),
      parser: makeParser({}),
    });
    expect(c.kind).toBe("ready");
  });

  it("explicit option password beats env", () => {
    process.env["TUTTI_EMAIL_PASSWORD"] = "shared";
    const c = createEmailClient({
      imap: { host: "h", port: 993, user: "u", password: "explicit-imap" },
      smtp: { host: "h", port: 587, user: "u", password: "explicit-smtp" },
      from: "x",
      imapFactory: () => makeMockImap(),
      smtpFactory: () => makeMockSmtp(),
      parser: makeParser({}),
    });
    expect(c.kind).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

describe("tools", () => {
  function readyClient() {
    process.env["TUTTI_EMAIL_PASSWORD"] = "secret";
    const imap = makeMockImap();
    const smtp = makeMockSmtp();
    const client = createEmailClient({
      imap: { host: "h", port: 993, user: "u" },
      smtp: { host: "h", port: 587, user: "u" },
      from: "Bot <bot@x>",
      imapFactory: () => imap,
      smtpFactory: () => smtp,
      parser: makeParser({}),
    });
    return { client, imap, smtp };
  }

  describe("send_email", () => {
    it("forwards args to wrapper.send", async () => {
      const { client, smtp } = readyClient();
      const tool = createSendEmailTool(client);
      const res = await tool.execute(
        { to: "alice@example.com", subject: "Hi", text: "Hello" },
        ctx,
      );
      expect(res.is_error).toBeUndefined();
      expect(smtp.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "Bot <bot@x>",
          to: "alice@example.com",
          subject: "Hi",
          text: "Hello",
        }),
      );
    });

    it("returns is_error on send failure", async () => {
      const { client, smtp } = readyClient();
      smtp.sendMail.mockRejectedValueOnce(new Error("EAUTH bad credentials"));
      const tool = createSendEmailTool(client);
      const res = await tool.execute({ to: "x@y", subject: "s", text: "t" }, ctx);
      expect(res.is_error).toBe(true);
      expect(res.content).toContain("EAUTH bad credentials");
    });
  });

  describe("send_reply", () => {
    it("sets In-Reply-To and appends the parent to References when missing", async () => {
      const { client, smtp } = readyClient();
      const tool = createSendReplyTool(client);
      await tool.execute(
        {
          to: "alice@example.com",
          subject: "Re: original",
          text: "thanks",
          in_reply_to: "<original@x>",
          references: ["<root@x>"],
        },
        ctx,
      );
      expect(smtp.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          inReplyTo: "<original@x>",
          references: ["<root@x>", "<original@x>"],
        }),
      );
    });

    it("does not duplicate the parent when it's already in References", async () => {
      const { client, smtp } = readyClient();
      const tool = createSendReplyTool(client);
      await tool.execute(
        {
          to: "alice@example.com",
          subject: "Re: original",
          text: "thanks",
          in_reply_to: "<original@x>",
          references: ["<root@x>", "<original@x>"],
        },
        ctx,
      );
      expect(smtp.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          inReplyTo: "<original@x>",
          references: ["<root@x>", "<original@x>"],
        }),
      );
    });
  });

  describe("list_inbox", () => {
    it("formats envelopes for the agent", async () => {
      const { client, imap } = readyClient();
      imap.setQueue([
        {
          uid: 1,
          envelope: {
            messageId: "<a@x>",
            subject: "Hi",
            from: [{ address: "u@x" }],
            date: new Date("2026-02-01T00:00:00Z"),
          },
        },
      ]);
      const tool = createListInboxTool(client);
      const res = await tool.execute({}, ctx);
      expect(res.is_error).toBeUndefined();
      expect(res.content).toContain("<a@x>");
      expect(res.content).toContain("u@x");
    });

    it("rejects an invalid since timestamp", async () => {
      const { client } = readyClient();
      const tool = createListInboxTool(client);
      const res = await tool.execute({ since: "not-a-date" }, ctx);
      expect(res.is_error).toBe(true);
      expect(res.content).toContain("Invalid 'since'");
    });
  });

  describe("guarding", () => {
    it("send_email returns kind=missing when no password configured", async () => {
      delete process.env["TUTTI_EMAIL_PASSWORD"];
      const c = createEmailClient({
        imap: { host: "h", port: 993, user: "u" },
        smtp: { host: "h", port: 587, user: "u" },
        from: "x",
      });
      const tool = createSendEmailTool(c);
      const res = await tool.execute({ to: "x@y", subject: "s", text: "t" }, ctx);
      expect(res.is_error).toBe(true);
      expect(res.content).toContain("password");
    });
  });
});

// ---------------------------------------------------------------------------
// EmailVoice
// ---------------------------------------------------------------------------

describe("EmailVoice", () => {
  it("registers three tools (send_email + send_reply + list_inbox)", () => {
    process.env["TUTTI_EMAIL_PASSWORD"] = "secret";
    const voice = new EmailVoice({
      imap: { host: "h", port: 993, user: "u" },
      smtp: { host: "h", port: 587, user: "u" },
      from: "Bot <bot@x>",
      imapFactory: () => makeMockImap(),
      smtpFactory: () => makeMockSmtp(),
      parser: makeParser({}),
    });
    expect(voice.name).toBe("email");
    expect(voice.required_permissions).toEqual(["network"]);
    const names = voice.tools.map((t) => t.name).sort();
    expect(names).toEqual(["list_inbox", "send_email", "send_reply"]);
    const destructive = voice.tools.filter((t) => t.destructive === true).map((t) => t.name).sort();
    expect(destructive).toEqual(["send_email", "send_reply"]);
  });

  it("teardown destroys the wrapper and empties the cache", async () => {
    process.env["TUTTI_EMAIL_PASSWORD"] = "secret";
    const voice = new EmailVoice({
      imap: { host: "h", port: 993, user: "u-voice" },
      smtp: { host: "h", port: 587, user: "u-voice" },
      from: "Bot <bot@x>",
      imapFactory: () => makeMockImap(),
      smtpFactory: () => makeMockSmtp(),
      parser: makeParser({}),
    });
    expect(EmailClientWrapper.cache.size).toBe(1);
    await voice.teardown();
    expect(EmailClientWrapper.cache.size).toBe(0);
  });
});
