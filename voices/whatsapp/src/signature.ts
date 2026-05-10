import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a Meta `X-Hub-Signature-256` header against the raw request
 * body using HMAC-SHA256 with the App Secret.
 *
 * Meta sends the header as `sha256=<hex-digest>`. Without verification,
 * any third party could POST to the webhook and forge inbound
 * messages — this is the single most important defence on the
 * webhook surface.
 *
 * Comparison is constant-time via {@link timingSafeEqual} to prevent
 * length-leak timing attacks. Returns `false` on missing header,
 * malformed prefix, or length mismatch (`timingSafeEqual` requires
 * equal-length buffers and would otherwise throw).
 *
 * @param rawBody - The exact request body bytes Meta hashed. Must be
 *   captured before JSON parsing — see the rawBody contentTypeParser
 *   in `server.ts`.
 * @param signatureHeader - The `X-Hub-Signature-256` header value.
 * @param appSecret - The Meta App Secret (NOT the access token).
 */
export function verifyMetaSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader) return false;
  if (!signatureHeader.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch — guard explicitly.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
