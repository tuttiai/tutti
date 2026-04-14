/**
 * SSRF guard for remote fetches. Rejects loopback, private-range, and
 * link-local addresses, plus non-http(s) schemes.
 */

const BLOCKED_HOSTS = new Set([
  "localhost",
  "0.0.0.0",
  "127.0.0.1",
  "::1",
  "[::1]",
]);

const PRIVATE_IPV4_RE =
  /^(?:10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

/**
 * Validate a URL string and return a parsed {@link URL}.
 *
 * @throws {Error} if the URL uses a disallowed scheme or targets a
 *                 private / loopback address.
 */
export function assertSafeUrl(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Invalid URL: " + input);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed: " + input);
  }

  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || PRIVATE_IPV4_RE.test(host)) {
    throw new Error("Private / loopback URLs are not allowed: " + input);
  }

  return parsed;
}
