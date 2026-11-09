/**
 * Zod schemas for the JSON bodies the Tutti server returns from its
 * `/interrupts/*` routes. Consumers such as `@tuttiai/cli` validate every
 * response with these before using it.
 *
 * Objects strip unknown keys (Zod's default) so a newer server that adds
 * a field never breaks an older client. Lists and strings are bounded to
 * keep rendering cheap; the bounds protect the renderers, not memory.
 *
 * @module
 */

import { z } from "zod";

/** Most interrupts accepted in one list. */
const MAX_ITEMS = 10_000;
/** Longest identifier, name or `resolved_by` accepted (the server caps `resolved_by` at 512). */
const MAX_NAME = 512;
/** Longest denial reason accepted (the server caps `reason` at 4096). */
const MAX_REASON = 4_096;

const name = z.string().max(MAX_NAME);
const isoDate = z.string().datetime();

/**
 * One interrupt request as the server serialises it: dates are ISO-8601
 * strings. Returned on its own by `POST /interrupts/:id/approve` and
 * `POST /interrupts/:id/deny`, and as list items by
 * `GET /interrupts/pending`.
 */
export const InterruptWireSchema = z.object({
  interrupt_id: name,
  session_id: name,
  tool_name: name,
  /** Tool arguments, stored verbatim; left unchecked on purpose. */
  tool_args: z.unknown(),
  requested_at: isoDate,
  status: z.enum(["pending", "approved", "denied"]),
  resolved_at: isoDate.optional(),
  resolved_by: name.optional(),
  denial_reason: z.string().max(MAX_REASON).optional(),
});

/** One interrupt request on the wire, derived from {@link InterruptWireSchema}. */
export type InterruptWire = z.infer<typeof InterruptWireSchema>;

/** Body of `GET /interrupts/pending`: every pending request, oldest first. */
export const InterruptsPendingResponseSchema = z.object({
  interrupts: z.array(InterruptWireSchema).max(MAX_ITEMS),
});

/** Body of `GET /interrupts/pending`, derived from {@link InterruptsPendingResponseSchema}. */
export type InterruptsPendingResponse = z.infer<typeof InterruptsPendingResponseSchema>;
