import type { z } from "zod";

import type { KnowledgeVoiceConfig } from "./config-schema.js";
import {
  ListBasesResponseSchema,
  SearchResponseSchema,
  type ListBasesResponse,
  type SearchRequest,
  type SearchResponse,
} from "./protocol.js";

/** The `fetch` the client calls. Injected so tests never reach a network. */
export type KnowledgeFetch = (input: string, init: RequestInit) => Promise<Response>;

/** An answer from the service, or the sentence to hand the model instead. */
export type KnowledgeResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly message: string };

/** The two calls the voice makes. */
export interface KnowledgeClient {
  listBases(): Promise<KnowledgeResult<ListBasesResponse>>;
  search(request: SearchRequest): Promise<KnowledgeResult<SearchResponse>>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** A service's own refusal sentence is passed on, but never at any length. */
const MESSAGE_LIMIT = 300;

/**
 * The configured url without a trailing slash, so both paths join cleanly.
 * A loop rather than `/\/+$/`, which backtracks polynomially on a long run of slashes.
 */
function baseOf(url: string): string {
  let base = url;
  while (base.endsWith("/")) base = base.slice(0, -1);
  return base;
}

/** Where a failure happened, without the path: the path names the agent, and the model needs only the host. */
function originOf(url: string): string {
  return new URL(url).origin;
}

/** The service's own `message`, if it sent one, shortened and with the token scrubbed in case it echoed it. */
async function refusalMessage(response: Response, token: string): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("message" in body)) return undefined;
    const message = body.message;
    if (typeof message !== "string" || message.length === 0) return undefined;
    return message.split(token).join("[redacted]").slice(0, MESSAGE_LIMIT);
  } catch {
    return undefined;
  }
}

/** The sentence for a non-2xx answer, with the fix where there is one. */
async function refusalOf(response: Response, token: string): Promise<string> {
  const said = await refusalMessage(response, token);
  if (response.status === 401 || response.status === 403) {
    return said ?? "The knowledge service refused this agent's token. Redeploy the agent so it is given a current one.";
  }
  if (response.status === 404) {
    return said ?? "The knowledge service does not know this agent. Redeploy the agent so its address is current.";
  }
  return said ?? `The knowledge service answered ${response.status}. Try again, and if it persists, ask its operator.`;
}

/**
 * Build the client for one agent's knowledge service.
 *
 * Every failure comes back as a sentence rather than a throw, because a tool never throws.
 *
 * @param config - The voice's parsed configuration.
 * @param fetchImpl - The `fetch` to call. Defaults to the global one.
 * @returns The client.
 *
 * @example
 * const client = createKnowledgeClient({ url: "http://kb.internal/agents/a1", token: "k" });
 * const found = await client.search({ query: "refund policy", top_k: 5 });
 */
export function createKnowledgeClient(config: KnowledgeVoiceConfig, fetchImpl: KnowledgeFetch = fetch): KnowledgeClient {
  const base = baseOf(config.url);
  const timeout = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  async function call<T>(path: string, init: RequestInit, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<KnowledgeResult<T>> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${config.token}`, accept: "application/json", ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError" ? `no answer within ${timeout} ms` : "the connection failed";
      return { ok: false, message: `Could not reach the knowledge service at ${originOf(base)}: ${reason}. Try again shortly.` };
    }
    if (!response.ok) return { ok: false, message: await refusalOf(response, config.token) };
    try {
      const body: unknown = await response.json();
      const parsed = schema.safeParse(body);
      if (parsed.success) return { ok: true, data: parsed.data };
    } catch {
      // A body that is not JSON is answered below, the same as one of the wrong shape.
    }
    return { ok: false, message: "The knowledge service answered in a shape this voice does not read. Its operator should check the service and voice versions." };
  }

  return {
    listBases: () => call("/bases", { method: "GET" }, ListBasesResponseSchema),
    search: (request) => call("/search", { method: "POST", body: JSON.stringify(request) }, SearchResponseSchema),
  };
}
