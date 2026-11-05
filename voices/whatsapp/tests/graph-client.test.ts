import { describe, expect, it, vi } from "vitest";
import { GraphClient, WhatsAppApiError } from "../src/graph-client.js";
import type { FetchLike } from "../src/graph-client.js";

interface FakeReply {
  ok?: boolean;
  status?: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}

function fetchReturning(reply: FakeReply): FetchLike {
  return vi.fn(async () => ({
    ok: reply.ok ?? true,
    status: reply.status ?? 200,
    statusText: reply.ok === false ? "Bad" : "OK",
    json: reply.json ?? (async () => ({})),
    text: reply.text ?? (async () => ""),
  }));
}

function client(fetchFn: FetchLike): GraphClient {
  return new GraphClient({ phoneNumberId: "123", accessToken: "test-token", fetchFn });
}

describe("GraphClient.resolveMedia", () => {
  it("returns url, MIME type and the optional checksum and size", async () => {
    const body = { url: "https://cdn.example/m", mime_type: "image/png", sha256: "abc", file_size: 12 };
    const media = await client(fetchReturning({ json: async () => body })).resolveMedia("m1");
    expect(media).toEqual({ url: "https://cdn.example/m", mimeType: "image/png", sha256: "abc", fileSize: 12 });
  });

  it("omits the optional fields when Graph does not send them", async () => {
    const body = { url: "https://cdn.example/m", mime_type: "audio/ogg" };
    const media = await client(fetchReturning({ json: async () => body })).resolveMedia("m2");
    expect(media).toEqual({ url: "https://cdn.example/m", mimeType: "audio/ogg" });
  });

  it("rejects a reply without url or mime_type", async () => {
    const graph = client(fetchReturning({ json: async () => ({ url: "x" }) }));
    await expect(graph.resolveMedia("m3")).rejects.toThrow("returned no url/mime_type");
  });

  it("surfaces a Meta error envelope as WhatsAppApiError", async () => {
    const json = async (): Promise<unknown> => ({ error: { message: "Unknown media", code: 100 } });
    const graph = client(fetchReturning({ ok: false, status: 400, json }));
    await expect(graph.resolveMedia("m4")).rejects.toBeInstanceOf(WhatsAppApiError);
  });
});

describe("GraphClient error parsing", () => {
  it("falls back to the raw text when the error body is not JSON", async () => {
    const json = async (): Promise<unknown> => Promise.reject(new SyntaxError("bad json"));
    const graph = client(fetchReturning({ ok: false, status: 502, json, text: async () => "gateway" }));
    await expect(graph.sendText("1", "hi")).rejects.toThrow("WhatsApp API HTTP 502 Bad: gateway");
  });

  it("still reports the status when the text body cannot be read either", async () => {
    const json = async (): Promise<unknown> => Promise.reject(new SyntaxError("bad json"));
    const text = async (): Promise<string> => Promise.reject(new Error("closed"));
    const graph = client(fetchReturning({ ok: false, status: 503, json, text }));
    await expect(graph.sendText("1", "hi")).rejects.toThrow("WhatsApp API HTTP 503 Bad: ");
  });

  it("reports JSON bodies without an error envelope verbatim", async () => {
    const graph = client(fetchReturning({ ok: false, status: 500, json: async () => ({ oops: true }) }));
    await expect(graph.sendText("1", "hi")).rejects.toThrow('WhatsApp API HTTP 500 Bad: {"oops":true}');
  });

  it("rejects a send reply that carries no message id", async () => {
    const graph = client(fetchReturning({ json: async () => ({ messages: [] }) }));
    await expect(graph.sendTemplate("1", "hello", "en_US")).rejects.toThrow("returned no message id");
  });
});
