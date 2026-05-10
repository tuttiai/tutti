import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { verifyMetaSignature } from "./signature.js";
import type { InboundWebhookPayload } from "./types.js";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Raw request body bytes — captured by the JSON contentTypeParser
     * registered in {@link buildWebhookServer}. Required for Meta
     * signature verification because Fastify's default JSON parsing
     * discards the original buffer.
     */
    rawBody?: Buffer;
  }
}

/** Handler invoked for every authenticated inbound payload. */
export type WebhookHandler = (payload: InboundWebhookPayload) => void | Promise<void>;

/**
 * Per-source rate limit applied at the HTTP boundary, before signature
 * verification. Defence-in-depth against floods that could DoS the
 * server or the downstream `onPayload` dispatcher even when their HMAC
 * is invalid.
 */
export interface WebhookRateLimit {
  /** Max requests per source per window. Default 100. */
  max?: number;
  /** Window length in milliseconds. Default 60_000 (1 minute). */
  windowMs?: number;
}

export interface WebhookServerOptions {
  verifyToken: string;
  appSecret: string;
  /** Body size limit for the webhook endpoint. Default 5 MB. */
  bodyLimit?: number;
  /** Inbound dispatch handler — called AFTER the 200 ack is sent. */
  onPayload: WebhookHandler;
  /**
   * HTTP-level rate limit applied per source IP before signature
   * verification. Defaults to 100 requests / 60s per IP. Set
   * `rateLimit: false` to disable (only safe behind a trusted upstream
   * that already rate-limits).
   */
  rateLimit?: WebhookRateLimit | false;
}

const DEFAULT_RATE_LIMIT_MAX = 100;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
/** Cap on tracked source IPs to bound memory under attack. */
const RATE_LIMIT_MAX_KEYS = 10_000;

/**
 * Build (but do not start) a Fastify instance hosting Meta's webhook
 * routes. Tests can call `server.inject({ … })` to exercise the
 * handlers without binding to a real port; the wrapper's `launch()`
 * calls `server.listen()`.
 *
 * Two routes are registered:
 * - `GET /webhook` — Meta's verification handshake. Returns
 *   `hub.challenge` plain-text on success, 403 on token mismatch.
 * - `POST /webhook` — inbound messages. Verifies the
 *   `X-Hub-Signature-256` header against the raw body using HMAC-SHA256
 *   with the App Secret; rejects with 401 on mismatch. Replies 200
 *   immediately and dispatches the payload to `onPayload`
 *   asynchronously — Meta retries non-2xx within ~20s, so blocking
 *   the response on agent work would cause duplicate deliveries.
 *
 * Rate-limited via `@fastify/rate-limit` ahead of signature
 * verification (default 100 req / 60s per source IP) so a flood of
 * unsigned or correctly-signed requests can't amplify cost on the
 * downstream `onPayload` dispatcher or starve real Meta deliveries.
 */
export async function buildWebhookServer(
  options: WebhookServerOptions,
): Promise<FastifyInstance> {
  const server = Fastify({
    logger: false,
    bodyLimit: options.bodyLimit ?? 5 * 1024 * 1024,
  });

  if (options.rateLimit !== false) {
    await server.register(rateLimit, {
      global: true,
      max: options.rateLimit?.max ?? DEFAULT_RATE_LIMIT_MAX,
      timeWindow: options.rateLimit?.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
      cache: RATE_LIMIT_MAX_KEYS,
      keyGenerator: (req) => req.ip || "unknown",
    });
  }

  // Preserve the raw body so we can verify Meta's HMAC signature.
  // Fastify's default JSON parser discards the buffer, which silently
  // breaks signature verification — the bug everyone hits once.
  server.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      try {
        const buf = body as Buffer;
        req.rawBody = buf;
        if (buf.length === 0) {
          done(null, {});
          return;
        }
        done(null, JSON.parse(buf.toString("utf8")));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  server.get("/webhook", async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const mode = q["hub.mode"];
    const token = q["hub.verify_token"];
    const challenge = q["hub.challenge"];
    if (mode === "subscribe" && token === options.verifyToken && typeof challenge === "string") {
      reply
        .code(200)
        .header("content-type", "text/plain; charset=utf-8")
        .send(challenge);
      return;
    }
    reply.code(403).send();
  });

  server.post("/webhook", async (req, reply) => {
    const sigHeader = req.headers["x-hub-signature-256"];
    const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    const raw = req.rawBody;
    if (!raw) {
      // Defensive — should never happen because of our contentTypeParser.
      reply.code(400).send({ error: "no body" });
      return;
    }
    if (!verifyMetaSignature(raw, sig, options.appSecret)) {
      reply.code(401).send({ error: "invalid signature" });
      return;
    }
    // ACK immediately. Meta retries non-2xx aggressively within ~20s.
    reply.code(200).send({ ok: true });
    // Dispatch asynchronously — never let a slow handler block the reply.
    queueMicrotask(() => {
      void Promise.resolve(options.onPayload(req.body as InboundWebhookPayload)).catch(() => {
        // Wrapper-level errors are surfaced via inbox:error events on
        // the orchestrator side. Swallow defensively to keep the
        // listener up.
      });
    });
  });

  return server;
}
