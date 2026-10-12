import { z } from "zod";
import type { Tool } from "@tuttiai/types";

import type { NotionClient } from "../client.js";
import { notionIdSchema } from "../utils/ids.js";
import { readBlocks, readChildren } from "../utils/read-blocks.js";
import { renderBlocks } from "../utils/render-blocks.js";

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
      const answer = await readBlocks(client, input.page_id, input.max_blocks);
      if (!answer.ok) return { content: answer.message, is_error: true };
      const { blocks, truncated } = answer.data;
      if (blocks.length === 0) return { content: `Page ${input.page_id} has no content.` };
      const more = truncated ? `\n\n(stopped at ${blocks.length} blocks; raise max_blocks to read further)` : "";
      return { content: `${renderBlocks(blocks, await readChildren(client, blocks))}${more}` };
    },
  };
}
