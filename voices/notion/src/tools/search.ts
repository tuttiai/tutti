import { z } from "zod";
import type { Tool } from "@tuttiai/types";

import type { NotionClient } from "../client.js";
import { SearchResponseSchema } from "../notion-schemas.js";
import { databaseTitle, pageTitle } from "../utils/format.js";

const parameters = z
  .object({
    query: z.string().max(1_000).default("").describe("Text to find in page and database titles. Empty lists everything shared with the integration."),
    filter: z.enum(["page", "database"]).optional().describe("Return only pages, or only databases."),
    page_size: z.number().int().min(1).max(100).default(10).describe("How many results to return (max 100)."),
    start_cursor: z.string().min(1).max(200).optional().describe("next_cursor from a previous search, for the next page of results."),
  })
  .strict();

/** The search body Notion reads, from the tool's input. */
function bodyOf(input: z.infer<typeof parameters>): Record<string, unknown> {
  return {
    ...(input.query.length > 0 ? { query: input.query } : {}),
    ...(input.filter === undefined ? {} : { filter: { property: "object", value: input.filter } }),
    page_size: input.page_size,
    ...(input.start_cursor === undefined ? {} : { start_cursor: input.start_cursor }),
  };
}

/**
 * `search`: pages and databases shared with the integration whose title matches a query.
 *
 * @param client - The Notion client.
 * @returns The tool.
 */
export function createSearchTool(client: NotionClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "search",
    description:
      "Search the Notion pages and databases shared with this integration by title. Returns each result's id, type, title and link.",
    parameters,
    execute: async (input) => {
      const answer = await client.request({ method: "POST", path: "/search", what: "search", body: bodyOf(input) }, SearchResponseSchema);
      if (!answer.ok) return { content: answer.message, is_error: true };
      if (answer.data.results.length === 0) {
        return {
          content: `Nothing shared with this integration matched "${input.query}". A page must be shared with the integration through its Connections menu in Notion before search can see it.`,
        };
      }
      const results = answer.data.results.map((item) => ({
        object: item.object,
        id: item.id,
        title: item.object === "page" ? pageTitle(item) : databaseTitle(item),
        url: item.url,
        last_edited_time: item.last_edited_time,
      }));
      return { content: JSON.stringify({ results, next_cursor: answer.data.has_more ? answer.data.next_cursor : null }) };
    },
  };
}
