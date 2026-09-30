import { z } from "zod";
import type { Tool } from "@tuttiai/types";

import type { NotionClient, NotionResult } from "../client.js";
import { DatabaseSchema, PageSchema } from "../notion-schemas.js";
import { pageTitle } from "../utils/format.js";
import { notionIdSchema } from "../utils/ids.js";
import { MAX_BLOCKS_PER_REQUEST, richText, textToBlocks, tooManyBlocksMessage } from "../utils/text-to-blocks.js";

const parameters = z
  .object({
    parent_type: z.enum(["page", "database"]).describe("Whether the parent is a page (the new page nests under it) or a database (the new page is a row)."),
    parent_id: notionIdSchema("parent page or database"),
    title: z.string().min(1).max(2_000).describe("The new page's title."),
    properties: z
      .record(z.record(z.unknown()))
      .optional()
      .describe(
        'Database parents only: property values keyed by property name, in Notion\'s shape, e.g. { "Status": { "status": { "name": "Todo" } } }. The title is set from title.',
      ),
    content: z
      .string()
      .max(100_000)
      .optional()
      .describe("Optional body as markdown-like text: # headings, - bullets, 1. numbered items, - [ ] to-dos, > quotes, --- dividers, ``` code fences, paragraphs."),
  })
  .strict();

type Input = z.infer<typeof parameters>;

/** The name of a database's title property, which Notion lets each database choose. */
async function titlePropertyOf(client: NotionClient, databaseId: string): Promise<NotionResult<string>> {
  const answer = await client.request({ method: "GET", path: `/databases/${databaseId}`, what: `database ${databaseId}` }, DatabaseSchema);
  if (!answer.ok) return answer;
  const entry = Object.entries(answer.data.properties).find(([, value]) => value.type === "title");
  if (entry === undefined) return { ok: false, message: `Database ${databaseId} has no title property, so no row can be created in it.` };
  return { ok: true, data: entry[0] };
}

/** The `parent` and `properties` for the new page. */
async function placementOf(client: NotionClient, input: Input): Promise<NotionResult<Record<string, unknown>>> {
  const title = { title: richText(input.title) };
  if (input.parent_type === "page") {
    if (input.properties !== undefined) {
      return { ok: false, message: "properties apply only to a database parent. A page under a page has a title and nothing else; drop properties or pass a database id." };
    }
    return { ok: true, data: { parent: { page_id: input.parent_id }, properties: { title } } };
  }
  const titleName = await titlePropertyOf(client, input.parent_id);
  if (!titleName.ok) return titleName;
  const properties = { ...input.properties, [titleName.data]: title };
  return { ok: true, data: { parent: { database_id: input.parent_id }, properties } };
}

/**
 * `create_page`: a new page under a page, or a new row in a database, with optional body text.
 *
 * @param client - The Notion client.
 * @returns The tool.
 */
export function createCreatePageTool(client: NotionClient): Tool<Input> {
  return {
    name: "create_page",
    description:
      "Create a Notion page under a parent page, or as a row in a database, with a title, optional database properties and optional markdown-like body.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const children = textToBlocks(input.content ?? "");
      if (children.length > MAX_BLOCKS_PER_REQUEST) return { content: tooManyBlocksMessage(children.length), is_error: true };
      const placement = await placementOf(client, input);
      if (!placement.ok) return { content: placement.message, is_error: true };
      const body = { ...placement.data, ...(children.length > 0 ? { children } : {}) };
      const answer = await client.request({ method: "POST", path: "/pages", what: `new page under ${input.parent_id}`, body }, PageSchema);
      if (!answer.ok) return { content: answer.message, is_error: true };
      return { content: `Created page "${pageTitle(answer.data)}" (${answer.data.id})${answer.data.url === undefined ? "" : `: ${answer.data.url}`}` };
    },
  };
}
