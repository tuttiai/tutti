import { z } from "zod";
import type { Tool } from "@tuttiai/types";

import type { NotionClient } from "../client.js";
import { PageSchema } from "../notion-schemas.js";
import { pageTitle, propertiesText } from "../utils/format.js";
import { notionIdSchema } from "../utils/ids.js";

const parameters = z.object({ page_id: notionIdSchema("page") }).strict();

/**
 * `get_page`: one page's title, link, dates, parent and every property as text.
 *
 * @param client - The Notion client.
 * @returns The tool.
 */
export function createGetPageTool(client: NotionClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "get_page",
    description:
      "Fetch a Notion page's title and properties (not its body; use get_page_body for that). Accepts the page id or its notion.so link.",
    parameters,
    execute: async (input) => {
      const answer = await client.request({ method: "GET", path: `/pages/${input.page_id}`, what: `page ${input.page_id}` }, PageSchema);
      if (!answer.ok) return { content: answer.message, is_error: true };
      const page = answer.data;
      return {
        content: JSON.stringify({
          id: page.id,
          title: pageTitle(page),
          url: page.url,
          archived: page.archived ?? false,
          created_time: page.created_time,
          last_edited_time: page.last_edited_time,
          parent: page.parent,
          properties: propertiesText(page),
        }),
      };
    },
  };
}
