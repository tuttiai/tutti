/**
 * SSRF guard for remote fetches. Rejects URLs that would read local,
 * loopback, private-range, or link-local addresses, or use schemes other
 * than http/https.
 *
 * NOTE: hostname-based blocks are best-effort — a fully SSRF-safe fetch
 * resolves DNS first. Callers should still run this before any network I/O.
 */
export class UrlValidationError extends Error {
  public readonly code = "URL_VALIDATION_FAILED";
  constructor(public readonly url: string, reason: string) {
    super("Refusing to fetch " + url + ": " + reason);
    this.name = "UrlValidationError";
  }
}

const BLOCKED_HOSTS = new Set([
  "localhost",
  "0.0.0.0",
  "127.0.0.1",
  "::1",
  "[::1]",
]);

// Private IPv4 ranges: 10/8, 172.16/12, 192.168/16, 169.254/16 (link-local).
const PRIVATE_IPV4_RE =
  /^(?:10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

/** Options accepted by {@link assertSafeUrl}. */
export interface SafeUrlOptions {
  /**
   * Skip the loopback / private-range / link-local host checks.
   *
   * Scheme and parse validation still run: `file:`, `gopher:` and a
   * malformed URL are refused either way. Only the host policy is relaxed,
   * which is the whole of what this flag is named for.
   *
   * @default false
   */
  allow_private?: boolean;
}

export function assertSafeUrl(
  input: string,
  options: SafeUrlOptions = {},
): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new UrlValidationError(input, "invalid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UrlValidationError(input, "only http(s) URLs are allowed");
  }

  // Scheme is checked above and always enforced; only the host policy below
  // is what an opt-out relaxes.
  if (options.allow_private === true) {
    return parsed;
  }

  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) {
    throw new UrlValidationError(input, "loopback host not allowed");
  }
  if (PRIVATE_IPV4_RE.test(host)) {
    throw new UrlValidationError(input, "private IP range not allowed");
  }

  return parsed;
}
