import { z } from "zod";
import type { Tool } from "@tuttiai/types";

import type { NotionClient } from "../client.js";
import { QueryResponseSchema } from "../notion-schemas.js";
import { pageSummary } from "../utils/format.js";
import { notionIdSchema } from "../utils/ids.js";

const parameters = z
  .object({
    database_id: notionIdSchema("database"),
    filter: z
      .record(z.unknown())
      .optional()
      .describe(
        'A Notion filter object, e.g. { "property": "Status", "status": { "equals": "Done" } }, or { "and": [ ... ] }.',
      ),
    sorts: z
      .array(z.record(z.unknown()))
      .max(10)
      .optional()
      .describe('Notion sort objects, e.g. [{ "property": "Due", "direction": "ascending" }].'),
    page_size: z.number().int().min(1).max(100).default(20).describe("How many rows to return (max 100)."),
    start_cursor: z.string().min(1).max(200).optional().describe("next_cursor from a previous query, for the next page of rows."),
  })
  .strict();

type Input = z.infer<typeof parameters>;

/** The query body Notion reads, from the tool's input. */
function bodyOf(input: Input): Record<string, unknown> {
  return {
    ...(input.filter === undefined ? {} : { filter: input.filter }),
    ...(input.sorts === undefined ? {} : { sorts: input.sorts }),
    page_size: input.page_size,
    ...(input.start_cursor === undefined ? {} : { start_cursor: input.start_cursor }),
  };
}

/**
 * `query_database`: rows of a Notion database, optionally filtered and sorted.
 *
 * @param client - The Notion client.
 * @returns The tool.
 */
export function createQueryDatabaseTool(client: NotionClient): Tool<Input> {
  return {
    name: "query_database",
    description:
      "Query a Notion database for its rows (pages), with an optional Notion filter and sorts. Returns each row's id, title, link and properties as text.",
    parameters,
    execute: async (input) => {
      const answer = await client.request(
        { method: "POST", path: `/databases/${input.database_id}/query`, what: `database ${input.database_id}`, body: bodyOf(input) },
        QueryResponseSchema,
      );
      if (!answer.ok) return { content: answer.message, is_error: true };
      if (answer.data.results.length === 0) return { content: `No rows in database ${input.database_id} matched.` };
      return {
        content: JSON.stringify({
          results: answer.data.results.map(pageSummary),
          next_cursor: answer.data.has_more ? answer.data.next_cursor : null,
        }),
      };
    },
  };
}
