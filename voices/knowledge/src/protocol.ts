import { z } from "zod";

/**
 * The knowledge service protocol, as this voice reads it.
 *
 * Two calls under the configured `url`, each with `Authorization: Bearer <token>`:
 *
 * - `GET  <url>/bases`  answers {@link ListBasesResponseSchema}
 * - `POST <url>/search` takes {@link SearchRequestSchema} and answers {@link SearchResponseSchema}
 *
 * A refusal is any non-2xx answer, ideally `{ error, message }`. The service decides which bases
 * this agent may read; the voice never names one it was not told about by `/bases`, and a base
 * the service withholds is simply absent from both answers. Unknown fields are ignored, so a
 * service can say more than this without breaking an older voice.
 */

/** One knowledge base the agent may search. */
export const KnowledgeBaseSummarySchema = z.object({
  handle: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  sources: z.number().int().nonnegative(),
  chunks: z.number().int().nonnegative(),
});

/** One knowledge base the agent may search. */
export type KnowledgeBaseSummary = z.infer<typeof KnowledgeBaseSummarySchema>;

/** `GET <url>/bases`. */
export const ListBasesResponseSchema = z.object({ bases: z.array(KnowledgeBaseSummarySchema) });

/** `GET <url>/bases`. */
export type ListBasesResponse = z.infer<typeof ListBasesResponseSchema>;

/** `POST <url>/search`. `bases` narrows the search to some of the agent's bases; absent means all. */
export const SearchRequestSchema = z.object({
  query: z.string().min(1).max(2_000),
  top_k: z.number().int().min(1).max(20),
  bases: z.array(z.string().min(1)).min(1).max(20).optional(),
});

/** `POST <url>/search`. */
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

/** One passage the search found. `location` is a URL or a path when the source has one. */
export const SearchHitSchema = z.object({
  base: z.string().min(1),
  source: z.string().min(1),
  title: z.string(),
  text: z.string(),
  score: z.number(),
  location: z.string().nullable(),
});

/** One passage the search found. */
export type SearchHit = z.infer<typeof SearchHitSchema>;

/** `POST <url>/search`. `mode` says whether meaning was searched, or words only. */
export const SearchResponseSchema = z.object({
  results: z.array(SearchHitSchema),
  mode: z.enum(["hybrid", "keyword"]),
  searched: z.array(z.string()),
});

/** `POST <url>/search`. */
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
