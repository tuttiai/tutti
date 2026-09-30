import { z } from "zod";
import type { Tool } from "@tuttiai/types";

import type { NotionClient } from "../client.js";
import { PageSchema } from "../notion-schemas.js";
import { pageTitle } from "../utils/format.js";
import { notionIdSchema } from "../utils/ids.js";

const parameters = z.object({ page_id: notionIdSchema("page") }).strict();

/**
 * `archive_page`: a page moved to Notion's Trash, with everything nested under it.
 *
 * @param client - The Notion client.
 * @returns The tool.
 */
export function createArchivePageTool(client: NotionClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "archive_page",
    description:
      "Archive a Notion page: it and every page nested under it move to Notion's Trash and disappear from the workspace for everyone. It can be restored from the Trash in Notion.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const answer = await client.request(
        { method: "PATCH", path: `/pages/${input.page_id}`, what: `page ${input.page_id}`, body: { archived: true } },
        PageSchema,
      );
      if (!answer.ok) return { content: answer.message, is_error: true };
      return { content: `Archived page "${pageTitle(answer.data)}" (${answer.data.id}). It is in Notion's Trash and can be restored from there.` };
    },
  };
}
