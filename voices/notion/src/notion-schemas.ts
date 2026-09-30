import { z } from "zod";

/**
 * The parts of Notion's answers (API version 2022-06-28) this voice reads.
 *
 * Each object is `.passthrough()`: Notion adds fields over time, and a property or block of a
 * type this voice does not know is still rendered by its type name rather than refused.
 */

/** One run of rich text. Only its `plain_text` is read. */
export const RichTextSchema = z.object({ plain_text: z.string() }).passthrough();

/** One property value on a page, keyed by its `type`. */
export const PropertyValueSchema = z.object({ type: z.string() }).passthrough();

/** One property value on a page. */
export type PropertyValue = z.infer<typeof PropertyValueSchema>;

/** A page, as `GET /pages/{id}` and the list endpoints answer it. */
export const PageSchema = z
  .object({
    object: z.literal("page"),
    id: z.string(),
    url: z.string().optional(),
    archived: z.boolean().optional(),
    created_time: z.string().optional(),
    last_edited_time: z.string().optional(),
    parent: z.unknown().optional(),
    properties: z.record(PropertyValueSchema),
  })
  .passthrough();

/** A page. */
export type Page = z.infer<typeof PageSchema>;

/** A database, as `GET /databases/{id}` and search answer it. */
export const DatabaseSchema = z
  .object({
    object: z.literal("database"),
    id: z.string(),
    url: z.string().optional(),
    last_edited_time: z.string().optional(),
    title: z.array(RichTextSchema).optional(),
    properties: z.record(PropertyValueSchema),
  })
  .passthrough();

/** A database. */
export type Database = z.infer<typeof DatabaseSchema>;

/** One block of page content. Its payload sits under a key named by its `type`. */
export const BlockSchema = z
  .object({ object: z.literal("block"), id: z.string(), type: z.string(), has_children: z.boolean().optional() })
  .passthrough();

/** One block of page content. */
export type Block = z.infer<typeof BlockSchema>;

/** A page of a paginated list. */
function listOf<T extends z.ZodTypeAny>(item: T): z.ZodObject<{
  results: z.ZodArray<T>;
  has_more: z.ZodBoolean;
  next_cursor: z.ZodNullable<z.ZodString>;
}> {
  return z.object({ results: z.array(item), has_more: z.boolean(), next_cursor: z.string().nullable() });
}

/** `POST /search`: pages and databases. */
export const SearchResponseSchema = listOf(z.union([PageSchema, DatabaseSchema]));

/** `POST /databases/{id}/query`. */
export const QueryResponseSchema = listOf(PageSchema);

/** `GET /blocks/{id}/children` and `PATCH /blocks/{id}/children`. */
export const BlockListSchema = listOf(BlockSchema);

/** A page of blocks. */
export type BlockList = z.infer<typeof BlockListSchema>;
