import { z } from "zod";
import type { Tool } from "@tuttiai/types";

import type { NotionClient } from "../client.js";
import { PageSchema } from "../notion-schemas.js";
import { pageTitle } from "../utils/format.js";
import { notionIdSchema } from "../utils/ids.js";

const parameters = z
  .object({
    page_id: notionIdSchema("page"),
    properties: z
      .record(z.record(z.unknown()))
      .refine((value) => Object.keys(value).length > 0, "Pass at least one property to change.")
      .describe(
        'Property values to set, keyed by property name, in Notion\'s shape, e.g. { "Status": { "status": { "name": "Done" } } } or { "title": { "title": [{ "text": { "content": "New name" } }] } }. Properties not named are left as they are.',
      ),
  })
  .strict();

/**
 * `update_page`: new values for some of a page's properties.
 *
 * @param client - The Notion client.
 * @returns The tool.
 */
export function createUpdatePageTool(client: NotionClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "update_page",
    description:
      "Set some properties of a Notion page (a database row's fields, or a page's title). Overwrites the named properties' current values; the body is not touched.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const answer = await client.request(
        { method: "PATCH", path: `/pages/${input.page_id}`, what: `page ${input.page_id}`, body: { properties: input.properties } },
        PageSchema,
      );
      if (!answer.ok) return { content: answer.message, is_error: true };
      const names = Object.keys(input.properties).join(", ");
      return { content: `Updated ${names} on page "${pageTitle(answer.data)}" (${answer.data.id}).` };
    },
  };
}
