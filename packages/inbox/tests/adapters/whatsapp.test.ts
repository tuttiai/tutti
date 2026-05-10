import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { WhatsAppClientWrapper } from "@tuttiai/whatsapp";
import type { FetchLike } from "@tuttiai/whatsapp";
import { WhatsAppInboxAdapter } from "../../src/adapters/whatsapp.js";
import type { InboxMessage } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers — mock fetch for outbound Graph calls; we exercise the inbox
// adapter through the wrapper's app.inject() so no port is bound.
// ---------------------------------------------------------------------------

function makeFetchOk(body: unknown = {}): FetchLike {
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

function signBody(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function makePayload(messages: unknown[]): unknown {
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
              messages,
            },
          },
        ],
      },
    ],
  };
}

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
// Tests
// ---------------------------------------------------------------------------

describe("WhatsAppInboxAdapter", () => {
  it("throws when secrets are missing", async () => {
    const adapter = new WhatsAppInboxAdapter({ phoneNumberId: "PNID-X" });
    await expect(adapter.start(async () => {})).rejects.toThrow(/WHATSAPP_ACCESS_TOKEN/);
  });

  it("dispatches an inbound text message to the orchestrator handler", async () => {
    process.env["WHATSAPP_ACCESS_TOKEN"] = "x";
    process.env["WHATSAPP_VERIFY_TOKEN"] = "verify";
    process.env["WHATSAPP_APP_SECRET"] = "secret";
    const fetchFn = makeFetchOk();
    const adapter = new WhatsAppInboxAdapter({
      phoneNumberId: "PNID-A",
      fetchFn,
    });
    const received: InboxMessage[] = [];

    // Stub launch() so the test doesn't actually bind a port. The
    // wrapper's app.inject() works without listen().
    const wrapperRef = { current: undefined as unknown as WhatsAppClientWrapper };
    const origLaunch = WhatsAppClientWrapper.prototype.launch;
    WhatsAppClientWrapper.prototype.launch = async function () {
      wrapperRef.current = this;
      // do not actually listen
    };
    try {
      await adapter.start(async (msg) => {
        received.push(msg);
      });
    } finally {
      WhatsAppClientWrapper.prototype.launch = origLaunch;
    }

    const wrapper = wrapperRef.current;
    expect(wrapper).toBeDefined();
    const app = await wrapper.whenReady();

    const payload = makePayload([
      {
        from: "14155552671",
        id: "wamid.X",
        timestamp: "1700000000",
        type: "text",
        text: { body: "hello inbox" },
      },
    ]);
    const body = JSON.stringify(payload);
    const sig = signBody(body, "secret");
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json", "x-hub-signature-256": sig },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    await new Promise<void>((r) => setImmediate(r));

    expect(received).toHaveLength(1);
    const im = received[0]!;
    expect(im.platform).toBe("whatsapp");
    expect(im.platform_user_id).toBe("14155552671");
    expect(im.platform_chat_id).toBe("14155552671"); // chat = sender on Cloud API
    expect(im.text).toBe("hello inbox");
    expect(im.timestamp).toBe(1_700_000_000_000);
    expect(im.raw).toBeDefined();
  });

  it("send() posts via Graph API to the recipient with the reply text", async () => {
    process.env["WHATSAPP_ACCESS_TOKEN"] = "x";
    process.env["WHATSAPP_VERIFY_TOKEN"] = "verify";
    process.env["WHATSAPP_APP_SECRET"] = "secret";
    const fetchFn = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ messages: [{ id: "wamid.OUT" }] }),
        text: async () => "",
      }) as Awaited<ReturnType<FetchLike>>,
    ) as unknown as FetchLike;
    const adapter = new WhatsAppInboxAdapter({
      phoneNumberId: "PNID-S",
      fetchFn,
    });
    const origLaunch = WhatsAppClientWrapper.prototype.launch;
    WhatsAppClientWrapper.prototype.launch = async function () {};
    try {
      await adapter.start(async () => {});
      await adapter.send("14155552671", { text: "thanks" });
    } finally {
      WhatsAppClientWrapper.prototype.launch = origLaunch;
    }
    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse((init as { body: string }).body);
    expect(body).toEqual({
      messaging_product: "whatsapp",
      to: "14155552671",
      type: "text",
      text: { body: "thanks" },
    });
  });

  it("send() skips empty replies", async () => {
    process.env["WHATSAPP_ACCESS_TOKEN"] = "x";
    process.env["WHATSAPP_VERIFY_TOKEN"] = "verify";
    process.env["WHATSAPP_APP_SECRET"] = "secret";
    const fetchFn = makeFetchOk();
    const adapter = new WhatsAppInboxAdapter({
      phoneNumberId: "PNID-E",
      fetchFn,
    });
    const origLaunch = WhatsAppClientWrapper.prototype.launch;
    WhatsAppClientWrapper.prototype.launch = async function () {};
    try {
      await adapter.start(async () => {});
      await adapter.send("14155552671", { text: "" });
    } finally {
      WhatsAppClientWrapper.prototype.launch = origLaunch;
    }
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("stop() releases the wrapper and empties the cache", async () => {
    process.env["WHATSAPP_ACCESS_TOKEN"] = "x";
    process.env["WHATSAPP_VERIFY_TOKEN"] = "verify";
    process.env["WHATSAPP_APP_SECRET"] = "secret";
    const fetchFn = makeFetchOk();
    const adapter = new WhatsAppInboxAdapter({
      phoneNumberId: "PNID-STOP",
      fetchFn,
    });
    const origLaunch = WhatsAppClientWrapper.prototype.launch;
    WhatsAppClientWrapper.prototype.launch = async function () {};
    try {
      await adapter.start(async () => {});
      expect(WhatsAppClientWrapper.cache.has("PNID-STOP")).toBe(true);
      await adapter.stop();
      expect(WhatsAppClientWrapper.cache.has("PNID-STOP")).toBe(false);
    } finally {
      WhatsAppClientWrapper.prototype.launch = origLaunch;
    }
  });
});
