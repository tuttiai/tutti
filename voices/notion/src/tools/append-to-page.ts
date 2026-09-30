import { z } from "zod";
import type { Tool } from "@tuttiai/types";

import type { NotionClient } from "../client.js";
import { BlockListSchema } from "../notion-schemas.js";
import { notionIdSchema } from "../utils/ids.js";
import { MAX_BLOCKS_PER_REQUEST, textToBlocks, tooManyBlocksMessage } from "../utils/text-to-blocks.js";

const parameters = z
  .object({
    page_id: notionIdSchema("page or block"),
    content: z
      .string()
      .min(1)
      .max(100_000)
      .describe("Text to add at the end, markdown-like: # headings, - bullets, 1. numbered items, - [ ] to-dos, > quotes, --- dividers, ``` code fences, paragraphs."),
  })
  .strict();

/**
 * `append_to_page`: text added to the end of a page, converted to blocks.
 *
 * @param client - The Notion client.
 * @returns The tool.
 */
export function createAppendToPageTool(client: NotionClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "append_to_page",
    description: "Append markdown-like text to the end of a Notion page (or inside any block that takes children). Existing content is left as it is.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const children = textToBlocks(input.content);
      if (children.length === 0) return { content: "The content holds nothing but blank lines, so there is nothing to append.", is_error: true };
      if (children.length > MAX_BLOCKS_PER_REQUEST) return { content: tooManyBlocksMessage(children.length), is_error: true };
      const answer = await client.request(
        { method: "PATCH", path: `/blocks/${input.page_id}/children`, what: `page ${input.page_id}`, body: { children } },
        BlockListSchema,
      );
      if (!answer.ok) return { content: answer.message, is_error: true };
      return { content: `Appended ${children.length} ${children.length === 1 ? "block" : "blocks"} to page ${input.page_id}.` };
    },
  };
}
