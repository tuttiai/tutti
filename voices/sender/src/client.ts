import { SecretsManager } from "@tuttiai/core";

/** Sender REST API base URL. */
export const SENDER_BASE_URL = "https://api.sender.net/v2";

/** Signature of the global `fetch`, swappable in tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Options for {@link createSenderClient}. */
export interface SenderClientOptions {
  /** Sender API token. Falls back to the SENDER_API_KEY environment variable. */
  api_key?: string;
  /** Test seam: replaces the global `fetch`. */
  fetch?: FetchLike;
}

/** Outcome of one API call. Never throws; the API token never appears in `message`. */
export type SenderResult =
  | { ok: true; data: unknown }
  | { ok: false; message: string };

/** One request to the Sender API. */
export interface SenderRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

/** Talks to the Sender API over HTTPS with bearer-token auth. */
export class SenderClientWrapper {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  /** Remove the token from any text before it can leave this class. */
  private redact(text: string): string {
    return text.split(this.apiKey).join("[redacted]");
  }

  /** Perform a request and fold every failure into a {@link SenderResult}. */
  async request(req: SenderRequest): Promise<SenderResult> {
    const url = new URL(`${SENDER_BASE_URL}${req.path}`);
    for (const [key, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const init: RequestInit = {
      method: req.method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    };
    if (req.body !== undefined) init.body = JSON.stringify(req.body);

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), init);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      return { ok: false, message: this.redact(`Could not reach Sender: ${reason}. Check network connectivity.`) };
    }

    let text = "";
    try {
      text = await res.text();
    } catch {
      text = "";
    }
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!res.ok) {
      return { ok: false, message: this.redact(describeFailure(res, parsed, text)) };
    }
    if (isRecord(parsed) && parsed["success"] === false) {
      return { ok: false, message: this.redact(`Sender rejected the request: ${messageOf(parsed) || "no reason given"}`) };
    }
    return { ok: true, data: parsed ?? {} };
  }
}

/** Either a usable client or the reason there is none. */
export type SenderClient =
  | { kind: "ready"; wrapper: SenderClientWrapper }
  | { kind: "missing"; message: string };

/**
 * Build a client from options, falling back to SENDER_API_KEY.
 *
 * @param options - Token and optional fetch override.
 * @returns A ready client, or a `missing` marker carrying setup instructions.
 */
export function createSenderClient(options: SenderClientOptions = {}): SenderClient {
  const api_key = options.api_key ?? SecretsManager.optional("SENDER_API_KEY");
  if (!api_key) {
    return {
      kind: "missing",
      message:
        "Sender voice is not configured. Set SENDER_API_KEY to an API access token from Sender (Settings > API access tokens).",
    };
  }
  return { kind: "ready", wrapper: new SenderClientWrapper(api_key, options.fetch) };
}

/** Narrow an unknown value to a plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(body: Record<string, unknown>): string {
  const parts: string[] = [];
  const msg = body["message"];
  if (typeof msg === "string") parts.push(msg);
  else if (isRecord(msg)) parts.push(JSON.stringify(msg));
  const errors = body["errors"];
  if (isRecord(errors)) {
    for (const [field, value] of Object.entries(errors)) {
      const list = Array.isArray(value) ? value.map(String).join(" ") : String(value);
      parts.push(`${field}: ${list}`);
    }
  }
  return parts.join(" | ");
}

function describeFailure(res: Response, body: unknown, raw: string): string {
  const detail = isRecord(body) ? messageOf(body) : raw.slice(0, 300);
  const suffix = detail ? `: ${detail}` : "";
  switch (res.status) {
    case 401:
      return `[401] Sender authentication failed. Check SENDER_API_KEY: the token may be wrong or revoked${suffix}`;
    case 403:
      return `[403] Sender refused the request. The token or plan may not allow this action${suffix}`;
    case 404:
      return `[404] Sender could not find that resource${suffix}`;
    case 422:
      return `[422] Sender rejected the input${suffix}`;
    case 429: {
      const retry = res.headers.get("retry-after");
      return `[429] Sender rate limit exceeded. ${retry ? `Retry after ${retry} seconds.` : "Slow down and retry shortly."}${suffix}`;
    }
    default:
      return res.status >= 500
        ? `[${res.status}] Sender server error. Retry later${suffix}`
        : `[${res.status}] Sender error${suffix}`;
  }
}
