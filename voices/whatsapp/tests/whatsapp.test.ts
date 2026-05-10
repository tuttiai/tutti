import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { ToolContext } from "@tuttiai/types";
import {
  WhatsAppVoice,
  WhatsAppClientWrapper,
  createWhatsAppClient,
  verifyMetaSignature,
  WhatsAppApiError,
  type FetchLike,
  type WhatsAppMessage,
} from "../src/index.js";
import { createSendTextMessageTool } from "../src/tools/send-text-message.js";
import { createSendTemplateMessageTool } from "../src/tools/send-template-message.js";
import type { InboundWebhookPayload } from "../src/types.js";

const ctx: ToolContext = { session_id: "test", agent_name: "test" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetchOk(body: unknown): FetchLike {
  return vi.fn(async () =>
    ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as Awaited<ReturnType<FetchLike>>,
  ) as unknown as FetchLike;
}

function makeFetchError(status: number, body: unknown): FetchLike {
  return vi.fn(async () =>
    ({
      ok: false,
      status,
      statusText: "Error",
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as Awaited<ReturnType<FetchLike>>,
  ) as unknown as FetchLike;
}

function signBody(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function makeSendOkResponse(messageId: string = "wamid.HBgL"): unknown {
  return {
    messaging_product: "whatsapp",
    contacts: [{ input: "123", wa_id: "123" }],
    messages: [{ id: messageId }],
  };
}

const baseConfig = {
  phoneNumberId: "PNID-1",
  accessToken: "EAA-test",
  verifyToken: "verify-secret",
  appSecret: "app-secret",
};

beforeEach(() => {
  WhatsAppClientWrapper.cache.clear();
  delete process.env["WHATSAPP_ACCESS_TOKEN"];
  delete process.env["WHATSAPP_VERIFY_TOKEN"];
  delete process.env["WHATSAPP_APP_SECRET"];
});

afterEach(() => {
  WhatsAppClientWrapper.cache.clear();
});

// ---------------------------------------------------------------------------
// verifyMetaSignature
// ---------------------------------------------------------------------------

describe("verifyMetaSignature", () => {
  it("accepts a correctly-signed body", () => {
    const body = Buffer.from('{"hello":"world"}', "utf8");
    const sig = signBody(body.toString("utf8"), "app-secret");
    expect(verifyMetaSignature(body, sig, "app-secret")).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = Buffer.from('{"hello":"world"}', "utf8");
    const sig = signBody(body.toString("utf8"), "app-secret");
    const tampered = Buffer.from('{"hello":"WORLD"}', "utf8");
    expect(verifyMetaSignature(tampered, sig, "app-secret")).toBe(false);
  });

  it("rejects a missing header", () => {
    const body = Buffer.from('{"hello":"world"}', "utf8");
    expect(verifyMetaSignature(body, undefined, "app-secret")).toBe(false);
  });

  it("rejects a header without the sha256= prefix", () => {
    const body = Buffer.from('{"hello":"world"}', "utf8");
    const hex = createHmac("sha256", "app-secret").update(body).digest("hex");
    expect(verifyMetaSignature(body, hex, "app-secret")).toBe(false);
    expect(verifyMetaSignature(body, "md5=" + hex, "app-secret")).toBe(false);
  });

  it("rejects a length-mismatched signature without throwing", () => {
    const body = Buffer.from("x", "utf8");
    // Truncated digest — different length than expected.
    expect(verifyMetaSignature(body, "sha256=abc", "app-secret")).toBe(false);
  });

  it("rejects when the wrong app secret is supplied", () => {
    const body = Buffer.from('{"x":1}', "utf8");
    const sig = signBody(body.toString("utf8"), "right-secret");
    expect(verifyMetaSignature(body, sig, "wrong-secret")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Webhook routes — via app.inject()
// ---------------------------------------------------------------------------

function makePayload(overrides: { messages?: unknown[]; statuses?: unknown[] } = {}): InboundWebhookPayload {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "1555…", phone_number_id: "PNID-1" },
              ...(overrides.messages !== undefined ? { messages: overrides.messages as never } : {}),
              ...(overrides.statuses !== undefined ? { statuses: overrides.statuses as never } : {}),
            },
          },
        ],
      },
    ],
  };
}

describe("WhatsAppClientWrapper webhook routes", () => {
  it("GET /webhook returns hub.challenge as plain text on a correct verify_token", async () => {
    const wrapper = new WhatsAppClientWrapper({ ...baseConfig, fetchFn: makeFetchOk({}) });
    const app = wrapper._app!;
    const res = await app.inject({
      method: "GET",
      url: "/webhook",
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "verify-secret",
        "hub.challenge": "abc-123",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("abc-123");
  });

  it("GET /webhook returns 403 on wrong verify_token", async () => {
    const wrapper = new WhatsAppClientWrapper({ ...baseConfig, fetchFn: makeFetchOk({}) });
    const app = wrapper._app!;
    const res = await app.inject({
      method: "GET",
      url: "/webhook",
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "WRONG",
        "hub.challenge": "abc",
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /webhook with a valid signature dispatches messages to subscribers", async () => {
    const wrapper = new WhatsAppClientWrapper({ ...baseConfig, fetchFn: makeFetchOk({}) });
    const handler = vi.fn();
    wrapper.subscribeMessage(handler);

    const payload = makePayload({
      messages: [
        {
          from: "14155552671",
          id: "wamid.X",
          timestamp: "1700000000",
          type: "text",
          text: { body: "hello" },
        },
      ],
    });
    const body = JSON.stringify(payload);
    const sig = signBody(body, "app-secret");
    const app = wrapper._app!;
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    // Dispatch is async — wait for the queued microtask.
    await new Promise<void>((r) => setImmediate(r));
    expect(handler).toHaveBeenCalledTimes(1);
    const msg = handler.mock.calls[0]?.[0] as WhatsAppMessage;
    expect(msg.messageId).toBe("wamid.X");
    expect(msg.from).toBe("14155552671");
    expect(msg.text).toBe("hello");
    expect(msg.timestamp).toBe(1_700_000_000_000);
  });

  it("POST /webhook with an invalid signature returns 401 and does not dispatch", async () => {
    const wrapper = new WhatsAppClientWrapper({ ...baseConfig, fetchFn: makeFetchOk({}) });
    const handler = vi.fn();
    wrapper.subscribeMessage(handler);

    const payload = makePayload({
      messages: [{ from: "1", id: "x", timestamp: "1", type: "text", text: { body: "hi" } }],
    });
    const app = wrapper._app!;
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=badbad",
      },
      payload: JSON.stringify(payload),
    });
    expect(res.statusCode).toBe(401);
    await new Promise<void>((r) => setImmediate(r));
    expect(handler).not.toHaveBeenCalled();
  });

  it("POST /webhook ignores status updates (delivery receipts)", async () => {
    const wrapper = new WhatsAppClientWrapper({ ...baseConfig, fetchFn: makeFetchOk({}) });
    const handler = vi.fn();
    wrapper.subscribeMessage(handler);

    const payload = makePayload({
      statuses: [
        { id: "wamid.X", status: "delivered", timestamp: "1700000001", recipient_id: "14155552671" },
      ],
    });
    const body = JSON.stringify(payload);
    const sig = signBody(body, "app-secret");
    const app = wrapper._app!;
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json", "x-hub-signature-256": sig },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    await new Promise<void>((r) => setImmediate(r));
    expect(handler).not.toHaveBeenCalled();
  });

  it("POST /webhook with an image message resolves media and populates the WhatsAppMessage.media field", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/MEDIA-1")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/x",
            mime_type: "image/jpeg",
            sha256: "deadbeef",
            file_size: 12345,
          }),
          text: async () => "",
        };
      }
      return { ok: true, status: 200, statusText: "OK", json: async () => ({}), text: async () => "" };
    }) as unknown as FetchLike;
    const wrapper = new WhatsAppClientWrapper({ ...baseConfig, fetchFn });
    const handler = vi.fn();
    wrapper.subscribeMessage(handler);

    const payload = makePayload({
      messages: [
        {
          from: "14155552671",
          id: "wamid.IMG",
          timestamp: "1700000002",
          type: "image",
          image: { id: "MEDIA-1", mime_type: "image/jpeg", caption: "look at this" },
        },
      ],
    });
    const body = JSON.stringify(payload);
    const sig = signBody(body, "app-secret");
    const app = wrapper._app!;
    await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json", "x-hub-signature-256": sig },
      payload: body,
    });
    // Wait for async dispatch + media resolve.
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    expect(handler).toHaveBeenCalledTimes(1);
    const msg = handler.mock.calls[0]?.[0] as WhatsAppMessage;
    expect(msg.text).toBe("[image] look at this");
    expect(msg.media).toEqual(
      expect.objectContaining({
        kind: "image",
        url: expect.stringContaining("lookaside"),
        mimeType: "image/jpeg",
      }),
    );
  });

  it("POST /webhook continues processing when one handler throws", async () => {
    const wrapper = new WhatsAppClientWrapper({ ...baseConfig, fetchFn: makeFetchOk({}) });
    const a = vi.fn(() => {
      throw new Error("boom");
    });
    const b = vi.fn();
    wrapper.subscribeMessage(a);
    wrapper.subscribeMessage(b);

    const payload = makePayload({
      messages: [{ from: "1", id: "x", timestamp: "1700000000", type: "text", text: { body: "hi" } }],
    });
    const body = JSON.stringify(payload);
    const sig = signBody(body, "app-secret");
    const app = wrapper._app!;
    await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json", "x-hub-signature-256": sig },
      payload: body,
    });
    await new Promise<void>((r) => setImmediate(r));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("rate-limits POST /webhook beyond the configured per-IP cap", async () => {
    const wrapper = new WhatsAppClientWrapper({
      ...baseConfig,
      fetchFn: makeFetchOk({}),
      rateLimit: { max: 2, windowMs: 60_000 },
    });
    const app = wrapper._app!;
    const payload = makePayload({
      messages: [{ from: "1", id: "x", timestamp: "1700000000", type: "text", text: { body: "hi" } }],
    });
    const body = JSON.stringify(payload);
    const sig = signBody(body, "app-secret");
    const send = () =>
      app.inject({
        method: "POST",
        url: "/webhook",
        headers: { "content-type": "application/json", "x-hub-signature-256": sig },
        payload: body,
      });
    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(200);
    const third = await send();
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({ error: "rate_limited" });
  });

  it("rate-limits GET /webhook verification too (DoS defence)", async () => {
    const wrapper = new WhatsAppClientWrapper({
      ...baseConfig,
      fetchFn: makeFetchOk({}),
      rateLimit: { max: 1, windowMs: 60_000 },
    });
    const app = wrapper._app!;
    const params = {
      "hub.mode": "subscribe",
      "hub.verify_token": "verify-secret",
      "hub.challenge": "abc",
    };
    expect((await app.inject({ method: "GET", url: "/webhook", query: params })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ method: "GET", url: "/webhook", query: params })).statusCode).toBe(
      429,
    );
  });

  it("rateLimit: false disables the limiter (high-volume trusted upstream)", async () => {
    const wrapper = new WhatsAppClientWrapper({
      ...baseConfig,
      fetchFn: makeFetchOk({}),
      rateLimit: false,
    });
    const app = wrapper._app!;
    const payload = makePayload({
      messages: [{ from: "1", id: "x", timestamp: "1700000000", type: "text", text: { body: "hi" } }],
    });
    const body = JSON.stringify(payload);
    const sig = signBody(body, "app-secret");
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/webhook",
        headers: { "content-type": "application/json", "x-hub-signature-256": sig },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it("redacts secrets in the dispatched text by default", async () => {
    const wrapper = new WhatsAppClientWrapper({ ...baseConfig, fetchFn: makeFetchOk({}) });
    const handler = vi.fn();
    wrapper.subscribeMessage(handler);
    const payload = makePayload({
      messages: [
        {
          from: "1",
          id: "x",
          timestamp: "1700000000",
          type: "text",
          text: { body: "secret: sk-abcdefghijklmnopqrstuvwxyz123" },
        },
      ],
    });
    const body = JSON.stringify(payload);
    const sig = signBody(body, "app-secret");
    const app = wrapper._app!;
    await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json", "x-hub-signature-256": sig },
      payload: body,
    });
    await new Promise<void>((r) => setImmediate(r));
    const msg = handler.mock.calls[0]?.[0] as WhatsAppMessage;
    expect(msg.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123");
  });
});

// ---------------------------------------------------------------------------
// Outbound — sendText / sendTemplate / 131047 mapping
// ---------------------------------------------------------------------------

describe("WhatsAppClientWrapper send", () => {
  it("sendText posts the right URL / headers / body", async () => {
    const fetchFn = makeFetchOk(makeSendOkResponse());
    const wrapper = new WhatsAppClientWrapper({ ...baseConfig, fetchFn });
    const res = await wrapper.sendText("14155552671", "hi");
    expect(res.messageId).toBe("wamid.HBgL");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("https://graph.facebook.com/v21.0/PNID-1/messages");
    expect((init as { method: string }).method).toBe("POST");
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe(
      "Bearer EAA-test",
    );
    const body = JSON.parse((init as { body: string }).body);
    expect(body).toEqual({
      messaging_product: "whatsapp",
      to: "14155552671",
      type: "text",
      text: { body: "hi" },
    });
  });

  it("sendText surfaces 131047 (re-engagement window) as a typed error", async () => {
    const fetchFn = makeFetchError(400, {
      error: {
        message: "Re-engagement message",
        code: 131047,
        type: "OAuthException",
        fbtrace_id: "AaBbCc",
      },
    });
    const wrapper = new WhatsAppClientWrapper({ ...baseConfig, fetchFn });
    await expect(wrapper.sendText("14155552671", "hi")).rejects.toBeInstanceOf(WhatsAppApiError);
    try {
      await wrapper.sendText("14155552671", "hi");
    } catch (err) {
      const e = err as WhatsAppApiError;
      expect(e.code).toBe(131047);
      expect(e.isReengagementWindowExpired).toBe(true);
    }
  });

  it("sendTemplate posts a template payload", async () => {
    const fetchFn = makeFetchOk(makeSendOkResponse("wamid.TPL"));
    const wrapper = new WhatsAppClientWrapper({ ...baseConfig, fetchFn });
    await wrapper.sendTemplate("14155552671", "welcome_v1", "en_US", [
      { type: "body", parameters: [{ type: "text", text: "Alice" }] },
    ]);
    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse((init as { body: string }).body);
    expect(body).toEqual({
      messaging_product: "whatsapp",
      to: "14155552671",
      type: "template",
      template: {
        name: "welcome_v1",
        language: { code: "en_US" },
        components: [{ type: "body", parameters: [{ type: "text", text: "Alice" }] }],
      },
    });
  });

  it("resolveMedia caches resolved media so a second call doesn't refetch", async () => {
    const fetchFn = makeFetchOk({
      url: "https://lookaside.fbsbx.com/x",
      mime_type: "image/png",
      sha256: "abc",
      file_size: 100,
    });
    const wrapper = new WhatsAppClientWrapper({ ...baseConfig, fetchFn });
    const a = await wrapper.resolveMedia("MEDIA-X");
    const b = await wrapper.resolveMedia("MEDIA-X");
    expect(a).toEqual(b);
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// forKey + ref counting + destroy
// ---------------------------------------------------------------------------

describe("WhatsAppClientWrapper.forKey", () => {
  it("returns the same instance for the same phoneNumberId and refs only release on the last destroy", async () => {
    const fetchFn = makeFetchOk({});
    const a = WhatsAppClientWrapper.forKey("PNID-1", { ...baseConfig, fetchFn });
    const b = WhatsAppClientWrapper.forKey("PNID-1", { ...baseConfig, fetchFn });
    expect(a).toBe(b);
    expect(a._refCount).toBe(2);
    await a.destroy();
    expect(WhatsAppClientWrapper.cache.has("PNID-1")).toBe(true);
    await b.destroy();
    expect(WhatsAppClientWrapper.cache.has("PNID-1")).toBe(false);
  });

  it("destroy is idempotent", async () => {
    const wrapper = new WhatsAppClientWrapper({ ...baseConfig, fetchFn: makeFetchOk({}) });
    await wrapper.destroy();
    await wrapper.destroy();
    expect(wrapper._listening).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createWhatsAppClient — credential resolution
// ---------------------------------------------------------------------------

describe("createWhatsAppClient", () => {
  it("returns kind=missing when WHATSAPP_ACCESS_TOKEN is unset", () => {
    const c = createWhatsAppClient({ phoneNumberId: "PNID-1" });
    expect(c.kind).toBe("missing");
    if (c.kind === "missing") expect(c.message).toContain("WHATSAPP_ACCESS_TOKEN");
  });

  it("returns kind=missing when WHATSAPP_VERIFY_TOKEN is unset", () => {
    process.env["WHATSAPP_ACCESS_TOKEN"] = "x";
    const c = createWhatsAppClient({ phoneNumberId: "PNID-1" });
    expect(c.kind).toBe("missing");
    if (c.kind === "missing") expect(c.message).toContain("WHATSAPP_VERIFY_TOKEN");
  });

  it("returns kind=missing when WHATSAPP_APP_SECRET is unset", () => {
    process.env["WHATSAPP_ACCESS_TOKEN"] = "x";
    process.env["WHATSAPP_VERIFY_TOKEN"] = "y";
    const c = createWhatsAppClient({ phoneNumberId: "PNID-1" });
    expect(c.kind).toBe("missing");
    if (c.kind === "missing") expect(c.message).toContain("WHATSAPP_APP_SECRET");
  });

  it("resolves all three secrets from env and returns kind=ready", () => {
    process.env["WHATSAPP_ACCESS_TOKEN"] = "x";
    process.env["WHATSAPP_VERIFY_TOKEN"] = "y";
    process.env["WHATSAPP_APP_SECRET"] = "z";
    const c = createWhatsAppClient({ phoneNumberId: "PNID-1", fetchFn: makeFetchOk({}) });
    expect(c.kind).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

describe("tools", () => {
  function readyClient() {
    process.env["WHATSAPP_ACCESS_TOKEN"] = "x";
    process.env["WHATSAPP_VERIFY_TOKEN"] = "y";
    process.env["WHATSAPP_APP_SECRET"] = "z";
    const fetchFn = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => makeSendOkResponse("wamid.TOOL"),
        text: async () => "",
      }) as Awaited<ReturnType<FetchLike>>,
    ) as unknown as FetchLike;
    const client = createWhatsAppClient({ phoneNumberId: "PNID-T", fetchFn });
    return { client, fetchFn };
  }

  it("send_text_message — happy path", async () => {
    const { client } = readyClient();
    const tool = createSendTextMessageTool(client);
    const res = await tool.execute({ to: "14155552671", text: "hi" }, ctx);
    expect(res.is_error).toBeUndefined();
    expect(res.content).toContain("wamid.TOOL");
  });

  it("send_text_message — surfaces 131047 with a clear human-readable message", async () => {
    process.env["WHATSAPP_ACCESS_TOKEN"] = "x";
    process.env["WHATSAPP_VERIFY_TOKEN"] = "y";
    process.env["WHATSAPP_APP_SECRET"] = "z";
    const fetchFn = makeFetchError(400, {
      error: { message: "Re-engagement message", code: 131047 },
    });
    const client = createWhatsAppClient({ phoneNumberId: "PNID-X", fetchFn });
    const tool = createSendTextMessageTool(client);
    const res = await tool.execute({ to: "14155552671", text: "hi" }, ctx);
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("24h window");
    expect(res.content).toContain("send_template_message");
  });

  it("send_template_message — happy path", async () => {
    const { client, fetchFn } = readyClient();
    const tool = createSendTemplateMessageTool(client);
    const res = await tool.execute(
      { to: "14155552671", template_name: "welcome", language_code: "en_US" },
      ctx,
    );
    expect(res.is_error).toBeUndefined();
    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse((init as { body: string }).body);
    expect(body.type).toBe("template");
  });

  it("send_text_message — kind=missing surfaces a configuration error", async () => {
    const c = createWhatsAppClient({ phoneNumberId: "PNID-MISSING" });
    const tool = createSendTextMessageTool(c);
    const res = await tool.execute({ to: "14155552671", text: "hi" }, ctx);
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("WHATSAPP_ACCESS_TOKEN");
  });
});

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

describe("WhatsAppVoice", () => {
  it("registers two destructive tools", () => {
    process.env["WHATSAPP_ACCESS_TOKEN"] = "x";
    process.env["WHATSAPP_VERIFY_TOKEN"] = "y";
    process.env["WHATSAPP_APP_SECRET"] = "z";
    const voice = new WhatsAppVoice({ phoneNumberId: "PNID-V", fetchFn: makeFetchOk({}) });
    expect(voice.name).toBe("whatsapp");
    expect(voice.required_permissions).toEqual(["network"]);
    const names = voice.tools.map((t) => t.name).sort();
    expect(names).toEqual(["send_template_message", "send_text_message"]);
    for (const t of voice.tools) expect(t.destructive).toBe(true);
  });

  it("teardown destroys the wrapper and empties the cache", async () => {
    process.env["WHATSAPP_ACCESS_TOKEN"] = "x";
    process.env["WHATSAPP_VERIFY_TOKEN"] = "y";
    process.env["WHATSAPP_APP_SECRET"] = "z";
    const voice = new WhatsAppVoice({ phoneNumberId: "PNID-VT", fetchFn: makeFetchOk({}) });
    expect(WhatsAppClientWrapper.cache.size).toBe(1);
    await voice.teardown();
    expect(WhatsAppClientWrapper.cache.size).toBe(0);
  });
});
