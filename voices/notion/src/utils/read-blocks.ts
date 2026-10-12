import type { NotionClient, NotionResult } from "../client.js";
import { BlockListSchema, type Block, type BlockList } from "../notion-schemas.js";

/** Notion answers at most this many blocks per request. */
const PAGE_LIMIT = 100;

/** At most this many blocks have their children read in one call, to stay inside Notion's rate limit. */
export const MAX_EXPANDED = 20;

/** A table is read up to this many rows. */
const MAX_TABLE_ROWS = 1_000;

/** A list item is read up to this many nested items. */
const MAX_LIST_CHILDREN = 100;

/** Block types whose children are read along with the page. */
const EXPANDED = new Set(["table", "bulleted_list_item", "numbered_list_item", "to_do", "toggle"]);

/** What reading a block's children gave: the blocks, and whether more were left unread. */
export interface BlocksRead {
  readonly blocks: Block[];
  readonly truncated: boolean;
}

/** One request's worth of a block's children. */
function readPage(client: NotionClient, blockId: string, query: string): Promise<NotionResult<BlockList>> {
  return client.request({ method: "GET", path: `/blocks/${blockId}/children?${query}`, what: `page ${blockId}` }, BlockListSchema);
}

/**
 * Page through `GET /blocks/{id}/children` until the list ends or `max` blocks are read.
 *
 * @param client - The Notion client.
 * @param blockId - The page or block whose children to read.
 * @param max - The most blocks to read.
 * @returns The blocks, and whether more were left, or the failure to report.
 */
export async function readBlocks(client: NotionClient, blockId: string, max: number): Promise<NotionResult<BlocksRead>> {
  const blocks: Block[] = [];
  let cursor: string | null = null;
  do {
    const size = Math.min(PAGE_LIMIT, max - blocks.length);
    const query: string = `page_size=${size}${cursor === null ? "" : `&start_cursor=${encodeURIComponent(cursor)}`}`;
    const answer: NotionResult<BlockList> = await readPage(client, blockId, query);
    if (!answer.ok) return answer;
    blocks.push(...answer.data.results);
    cursor = answer.data.has_more ? answer.data.next_cursor : null;
  } while (cursor !== null && blocks.length < max);
  return { ok: true, data: { blocks, truncated: cursor !== null } };
}

/**
 * Read one level of children for the tables, list items and toggles among `blocks`, so a table's
 * rows and a list's nested items render in place. At most {@link MAX_EXPANDED} blocks are
 * expanded per call, in page order, one request after another. A block left unexpanded, or whose
 * children could not be read, keeps the pointer to read it by.
 *
 * @param client - The Notion client.
 * @param blocks - The blocks just read.
 * @returns The children read, keyed by parent id.
 */
export async function readChildren(client: NotionClient, blocks: readonly Block[]): Promise<Map<string, Block[]>> {
  const children = new Map<string, Block[]>();
  const parents = blocks.filter((block) => block.has_children === true && EXPANDED.has(block.type)).slice(0, MAX_EXPANDED);
  for (const parent of parents) {
    const max = parent.type === "table" ? MAX_TABLE_ROWS : MAX_LIST_CHILDREN;
    const answer = await readBlocks(client, parent.id, max);
    if (answer.ok) children.set(parent.id, answer.data.blocks);
  }
  return children;
}
