import type { z } from "zod";
import { SecretsManager } from "@tuttiai/core";

import { MISSING_TOKEN_MESSAGE, refusalMessage, type NotionRefusal } from "./utils/errors.js";

/** Every call goes here and nowhere else; no tool takes an address. */
export const NOTION_API_BASE = "https://api.notion.com/v1";

/**
 * The Notion API version this voice reads. Pinned, so a change on Notion's side cannot silently
 * change the shapes the tools format.
 */
export const NOTION_VERSION = "2022-06-28";

const TIMEOUT_MS = 15_000;

/** The `fetch` the client calls. Injected so tests never reach a network. */
export type NotionFetch = (input: string, init: RequestInit) => Promise<Response>;

/** An answer from Notion, or the sentence to hand the model instead. */
export type NotionResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly message: string };

/** One call to the Notion API. `what` names its subject in any failure, such as `page 0123…`. */
export interface NotionRequest {
  readonly method: "GET" | "POST" | "PATCH";
  readonly path: string;
  readonly what: string;
  readonly body?: unknown;
}

/** The one method every tool calls through. */
export interface NotionClient {
  request<T>(call: NotionRequest, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<NotionResult<T>>;
}

/** Options for {@link createNotionClient}. */
export interface NotionClientOptions {
  /** Internal integration secret. Defaults to NOTION_TOKEN. */
  readonly token?: string | undefined;
  /** The `fetch` to call. Defaults to the global one. */
  readonly fetch?: NotionFetch | undefined;
}

/** Read Notion's `{ code, message }` error body, if it sent one. */
async function refusalOf(response: Response): Promise<NotionRefusal> {
  const base = { status: response.status, retryAfter: response.headers.get("retry-after") };
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return { ...base, code: undefined, message: undefined };
    const code = "code" in body && typeof body.code === "string" ? body.code : undefined;
    const message = "message" in body && typeof body.message === "string" ? body.message : undefined;
    return { ...base, code, message };
  } catch {
    return { ...base, code: undefined, message: undefined };
  }
}

/** Parse a 2xx body against the tool's schema. */
async function parsed<T>(response: Response, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<NotionResult<T>> {
  try {
    const body: unknown = await response.json();
    const result = schema.safeParse(body);
    if (result.success) return { ok: true, data: result.data };
  } catch {
    // A body that is not JSON is answered below, the same as one of the wrong shape.
  }
  return { ok: false, message: `Notion answered in a shape this voice does not read (Notion-Version ${NOTION_VERSION}). Report it to the voice's maintainers.` };
}

/** The request init: bearer token, pinned version, JSON body, no redirects, a bounded wait. */
function initFor(call: NotionRequest, token: string): RequestInit {
  return {
    method: call.method,
    headers: {
      authorization: `Bearer ${token}`,
      "notion-version": NOTION_VERSION,
      accept: "application/json",
      ...(call.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
    // The token must never follow a redirect to another host.
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
}

/**
 * Build the client every Notion tool calls through.
 *
 * Every failure, a missing token included, comes back as a sentence rather than a throw,
 * because a tool never throws. The token appears only in the `Authorization` header.
 *
 * @param options - The token, falling back to NOTION_TOKEN, and the `fetch` to call.
 * @returns The client.
 *
 * @example
 * const client = createNotionClient({ token: "ntn_..." });
 * const page = await client.request({ method: "GET", path: "/pages/0123…", what: "page 0123…" }, PageSchema);
 */
export function createNotionClient(options: NotionClientOptions = {}): NotionClient {
  const token = options.token ?? SecretsManager.optional("NOTION_TOKEN");
  const fetchImpl = options.fetch ?? fetch;

  return {
    async request<T>(call: NotionRequest, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<NotionResult<T>> {
      if (token === undefined || token.length === 0) return { ok: false, message: MISSING_TOKEN_MESSAGE };
      let response: Response;
      try {
        response = await fetchImpl(`${NOTION_API_BASE}${call.path}`, initFor(call, token));
      } catch (error) {
        const reason = error instanceof Error && error.name === "TimeoutError" ? `no answer within ${TIMEOUT_MS} ms` : "the connection failed";
        return { ok: false, message: `Could not reach Notion at ${NOTION_API_BASE} for ${call.what}: ${reason}. Try again shortly.` };
      }
      if (!response.ok) return { ok: false, message: refusalMessage(await refusalOf(response), call.what, token) };
      return parsed(response, schema);
    },
  };
}
