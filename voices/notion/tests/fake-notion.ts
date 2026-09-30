import { vi } from "vitest";
import type { Tool, ToolResult } from "@tuttiai/types";

import { NotionVoice, type NotionFetch } from "../src/index.js";

/** A fake integration secret, shaped like a real one so the scrubbing is exercised. */
export const TOKEN = "ntn_FAKEtesttoken0123456789abcdefABCDEF0123456789";

export const PAGE_ID = "0123456789abcdef0123456789abcdef";
export const PAGE_UUID = "01234567-89ab-cdef-0123-456789abcdef";
export const DB_ID = "fedcba9876543210fedcba9876543210";
export const DB_UUID = "fedcba98-7654-3210-fedc-ba9876543210";

export const CONTEXT = { session_id: "s", agent_name: "a" };

/** A JSON answer. */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Rich text as Notion answers it. */
export function rich(text: string): { type: "text"; plain_text: string; text: { content: string } }[] {
  return [{ type: "text", plain_text: text, text: { content: text } }];
}

/** A page as Notion answers it. */
export function page(title: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object: "page",
    id: PAGE_UUID,
    url: `https://www.notion.so/${title}-${PAGE_ID}`,
    archived: false,
    created_time: "2026-09-01T10:00:00.000Z",
    last_edited_time: "2026-09-02T10:00:00.000Z",
    parent: { type: "workspace", workspace: true },
    properties: { Name: { id: "title", type: "title", title: rich(title) } },
    ...extra,
  };
}

/** A block as Notion answers it. */
export function block(type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { object: "block", id: `${type}-id`, type, has_children: false, [type]: payload, ...extra };
}

/** A paginated list as Notion answers it. */
export function list(results: unknown[], nextCursor: string | null = null): Record<string, unknown> {
  return { object: "list", results, has_more: nextCursor !== null, next_cursor: nextCursor };
}

/** A fake `fetch` answering each call in turn. */
export function fakeFetch(...answers: Response[]): ReturnType<typeof vi.fn<NotionFetch>> {
  const fn = vi.fn<NotionFetch>();
  for (const answer of answers) fn.mockResolvedValueOnce(answer);
  return fn;
}

/** A voice over a fake `fetch`. */
export function voiceWith(fetchImpl: NotionFetch): NotionVoice {
  return new NotionVoice({ token: TOKEN }, { fetch: fetchImpl });
}

/** Parse raw input with the tool's own schema, as the runtime does, then run it. */
export async function run(voice: NotionVoice, name: string, raw: unknown): Promise<ToolResult> {
  const found: Tool | undefined = voice.tools.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found.execute(found.parameters.parse(raw), CONTEXT);
}

/** The URL, init and parsed JSON body of the n-th call. */
export function callOf(fn: ReturnType<typeof vi.fn<NotionFetch>>, n = 0): { url: string; init: RequestInit; body: unknown } {
  const call = fn.mock.calls[n];
  if (call === undefined) throw new Error(`no call ${n}`);
  const [url, init] = call;
  return { url, init, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
}
