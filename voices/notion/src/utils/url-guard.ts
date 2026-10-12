/** Notion refuses a URL longer than this in a link, image or bookmark. */
const URL_LIMIT = 2_000;

/** Host names that always mean this machine or its network. */
const BLOCKED_HOSTS = new Set(["localhost", "0.0.0.0", "[::]", "[::1]"]);

/**
 * IPv4 loopback, unspecified, private, link-local and carrier-grade NAT ranges:
 * 127/8, 0/8, 10/8, 172.16/12, 192.168/16, 169.254/16 and 100.64/10.
 */
const PRIVATE_IPV4 = /^(?:127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/** IPv6 unique-local (fc00::/7), link-local (fe80::/10) and IPv4-mapped addresses, bracketed as `URL` gives them. */
const PRIVATE_IPV6 = /^\[(?:f[cd][0-9a-f]{0,2}:|fe[89ab][0-9a-f]?:|::ffff:)/;

/** Whether a host, as `URL.hostname` gives it, names a loopback or private address. */
function isPrivateHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTS.has(name) || name.endsWith(".localhost")) return true;
  return PRIVATE_IPV4.test(name) || PRIVATE_IPV6.test(name);
}

/**
 * The URL if it is safe to hand Notion, or `undefined`.
 *
 * Safe means it parses, uses `https:` (or `http:` when `allowHttp` is set), carries no
 * credentials, is no longer than Notion takes, and does not name a loopback or private host.
 * Notion fetches image and bookmark URLs from its own servers, so the host check keeps an agent
 * from pointing it at an internal address. The check is on the name as written; it does not
 * resolve DNS.
 *
 * @param text - The candidate URL.
 * @param allowHttp - Whether plain `http:` is accepted too, as it is for links.
 * @returns The URL as written, or `undefined` when it is refused.
 *
 * @example
 * safeUrl("https://example.com/a.png", false); // "https://example.com/a.png"
 * safeUrl("https://127.0.0.1/a.png", false); // undefined
 */
export function safeUrl(text: string, allowHttp: boolean): string | undefined {
  if (text.length > URL_LIMIT) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return undefined;
  }
  const schemeOk = parsed.protocol === "https:" || (allowHttp && parsed.protocol === "http:");
  if (!schemeOk || parsed.username !== "" || parsed.password !== "") return undefined;
  return isPrivateHost(parsed.hostname) ? undefined : text;
}
