import type { Permission, Tool, Voice } from "@tuttiai/types";

import { createNotionClient, type NotionFetch } from "./client.js";
import { NotionVoiceConfigSchema, type NotionVoiceConfig } from "./config-schema.js";
import { createAppendToPageTool } from "./tools/append-to-page.js";
import { createArchivePageTool } from "./tools/archive-page.js";
import { createCreatePageTool } from "./tools/create-page.js";
import { createGetPageBodyTool } from "./tools/get-page-body.js";
import { createGetPageTool } from "./tools/get-page.js";
import { createQueryDatabaseTool } from "./tools/query-database.js";
import { createSearchTool } from "./tools/search.js";
import { createUpdatePageTool } from "./tools/update-page.js";

/** What {@link NotionVoice} takes besides its configuration. */
export interface NotionVoiceDependencies {
  /** The `fetch` to call. Defaults to the global one; tests pass a fake. */
  readonly fetch?: NotionFetch;
}

/**
 * Gives an agent the Notion pages and databases shared with one internal integration: search,
 * read a page's properties and body, query a database, and create, append to, update and
 * archive pages.
 *
 * Notion shows an integration nothing until a person shares a page with it through the page's
 * Connections menu, so what the agent can reach is decided in Notion, page by page. Every tool
 * that writes is `destructive`, as Slack's posts and Stripe's creates are, because each one
 * changes what everyone with access to the page sees.
 *
 * The voice calls Notion's REST API with `fetch`, pinned to Notion-Version 2022-06-28, and holds
 * no connection, so there is nothing to tear down.
 */
export class NotionVoice implements Voice {
  name = "notion";
  description = "Search, read and write the Notion pages and databases shared with an integration";
  required_permissions: Permission[] = ["network"];
  tools: Tool[];

  /**
   * @param config - The integration token, falling back to NOTION_TOKEN. Validated here too, so
   * a caller that skipped the schema still cannot pass an unknown option.
   * @param dependencies - The `fetch` to call.
   */
  constructor(config: NotionVoiceConfig = {}, dependencies: NotionVoiceDependencies = {}) {
    const parsed = NotionVoiceConfigSchema.parse(config);
    const client = createNotionClient({ token: parsed.token, fetch: dependencies.fetch });
    this.tools = [
      createSearchTool(client),
      createGetPageTool(client),
      createGetPageBodyTool(client),
      createQueryDatabaseTool(client),
      createCreatePageTool(client),
      createAppendToPageTool(client),
      createUpdatePageTool(client),
      createArchivePageTool(client),
    ];
  }
}

export { createNotionClient, NOTION_API_BASE, NOTION_VERSION } from "./client.js";
export type { NotionClient, NotionClientOptions, NotionFetch, NotionRequest, NotionResult } from "./client.js";
export { NotionVoiceConfigSchema, type NotionVoiceConfig } from "./config-schema.js";
export { normaliseNotionId } from "./utils/ids.js";
