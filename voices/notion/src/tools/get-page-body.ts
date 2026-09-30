import { z } from "zod";
import type { Tool } from "@tuttiai/types";

import type { NotionClient, NotionResult } from "../client.js";
import { BlockListSchema, type Block, type BlockList } from "../notion-schemas.js";
import { notionIdSchema } from "../utils/ids.js";
import { renderBlocks } from "../utils/render-blocks.js";

/** Notion answers at most this many blocks per request. */
const PAGE_LIMIT = 100;

const parameters = z
  .object({
    page_id: notionIdSchema("page or block"),
    max_blocks: z
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(300)
      .describe("Stop after this many top-level blocks (max 1000). Nested blocks are not fetched."),
  })
  .strict();

type Input = z.infer<typeof parameters>;

/** What reading a page gave: its blocks, and whether more were left unread. */
interface Read {
  readonly blocks: Block[];
  readonly truncated: boolean;
}

/** One request's worth of a block's children. */
function readPage(client: NotionClient, pageId: string, query: string): Promise<NotionResult<BlockList>> {
  return client.request({ method: "GET", path: `/blocks/${pageId}/children?${query}`, what: `page ${pageId}` }, BlockListSchema);
}

/** Page through `GET /blocks/{id}/children` until the page ends or `max_blocks` is reached. */
async function readBlocks(client: NotionClient, input: Input): Promise<NotionResult<Read>> {
  const blocks: Block[] = [];
  let cursor: string | null = null;
  do {
    const size = Math.min(PAGE_LIMIT, input.max_blocks - blocks.length);
    const query: string = `page_size=${size}${cursor === null ? "" : `&start_cursor=${encodeURIComponent(cursor)}`}`;
    const answer: NotionResult<BlockList> = await readPage(client, input.page_id, query);
    if (!answer.ok) return answer;
    blocks.push(...answer.data.results);
    cursor = answer.data.has_more ? answer.data.next_cursor : null;
  } while (cursor !== null && blocks.length < input.max_blocks);
  return { ok: true, data: { blocks, truncated: cursor !== null } };
}

/**
 * `get_page_body`: a page's body, rendered as markdown-like text.
 *
 * @param client - The Notion client.
 * @returns The tool.
 */
export function createGetPageBodyTool(client: NotionClient): Tool<Input> {
  return {
    name: "get_page_body",
    description:
      "Read the body of a Notion page (or the children of any block) as markdown-like text: headings, lists, to-dos, code, quotes and paragraphs. Nested blocks are listed with the id to read them by.",
    parameters,
    execute: async (input) => {
      const answer = await readBlocks(client, input);
      if (!answer.ok) return { content: answer.message, is_error: true };
      const { blocks, truncated } = answer.data;
      if (blocks.length === 0) return { content: `Page ${input.page_id} has no content.` };
      const more = truncated ? `\n\n(stopped at ${blocks.length} blocks; raise max_blocks to read further)` : "";
      return { content: `${renderBlocks(blocks)}${more}` };
    },
  };
}
