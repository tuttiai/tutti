/**
 * Wait-for-event node and event types for {@link TuttiGraph}.
 *
 * Experimental: these types let a graph declare a wait, and the builder
 * validates it, but the engine does not execute wait nodes yet. A graph
 * that declares one is refused at run time.
 */

import { z } from "zod";

/** Any value that survives `JSON.parse(JSON.stringify(value))` unchanged. */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function isPlainObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const JsonObjectSchema: z.ZodType<{ [key: string]: JsonValue }> = z.lazy(() =>
  z
    .record(JsonValueSchema)
    .refine(isPlainObject, { message: "Expected a plain object" }),
);

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    JsonObjectSchema,
  ]),
);

/** @internal Zod schema for {@link WaitMatch}. */
export const WaitMatchSchema = JsonObjectSchema;

/** @internal Zod schema for {@link WaitTimeout}. */
export const WaitTimeoutSchema = z
  .object({
    after_ms: z.number().int().positive(),
    to: z.string().min(1),
  })
  .strict();

/** @internal Zod schema for {@link WaitNode}. Not exported from the package. */
export const WaitNodeSchema = z
  .object({
    kind: z.literal("wait"),
    id: z.string().min(1),
    event: z.string().refine((s) => s.trim().length > 0, {
      message: "Event name must not be empty",
    }),
    match: WaitMatchSchema.optional(),
    timeout: WaitTimeoutSchema.optional(),
    description: z.string().optional(),
  })
  .strict();

/**
 * Payload filter for a {@link WaitNode}: a plain JSON object. An event
 * matches when every key in `match` deep-equals the value at the same
 * path in the event payload, so `{}` matches any payload.
 *
 * Stored as plain JSON (not a predicate or a Zod schema) so a wait can be
 * checkpointed and resumed in another process.
 *
 * @experimental The engine does not execute wait nodes yet.
 */
export type WaitMatch = z.infer<typeof WaitMatchSchema>;

/**
 * Timeout of a {@link WaitNode} and the branch taken when it fires.
 *
 * - `after_ms`: positive integer, milliseconds to wait before giving up.
 *   No upper bound: durable waits may last days.
 * - `to`: node id to continue at on timeout, or `END`. This branch is not
 *   an edge; the wait node's ordinary outgoing edges are the resume path.
 *
 * @experimental The engine does not execute wait nodes yet.
 */
export type WaitTimeout = z.infer<typeof WaitTimeoutSchema>;

/**
 * A node that pauses the graph until a named event arrives.
 *
 * - `kind`: always `"wait"`.
 * - `id`: unique across agent nodes and waits; shares their id space.
 * - `event`: name of the event to wait for, for example `"order.paid"`.
 * - `match`: optional {@link WaitMatch} on the event payload.
 * - `timeout`: optional {@link WaitTimeout} with its branch.
 * - `description`: human-readable description for debugging.
 *
 * Declared through {@link GraphConfig.waits} or {@link GraphBuilder.wait}.
 * A wait node may not be the entrypoint or the target of a parallel edge.
 *
 * @experimental The engine does not execute wait nodes yet; running a
 * graph that declares one throws {@link GraphValidationError}.
 */
export type WaitNode = z.infer<typeof WaitNodeSchema>;

/**
 * {@link GraphEvent} member emitted when a run starts waiting at a
 * {@link WaitNode}. `wait_id` identifies this wait instance (a node can be
 * visited more than once in a loop); `timeout_at` is the absolute deadline
 * in epoch milliseconds, present when the node has a timeout.
 *
 * @experimental Nothing emits this event yet.
 */
export type NodeWaitingEvent = {
  type: "node:waiting";
  node_id: string;
  wait_id: string;
  event: string;
  match?: WaitMatch;
  timeout_at?: number;
};

/**
 * {@link GraphEvent} member emitted when a waiting run continues.
 * `reason` says whether the event arrived or the timeout fired;
 * `payload` is the event payload and is present only when `reason` is
 * `"event"`; `next_node_id` is the node the run continues at (or `END`).
 *
 * @experimental Nothing emits this event yet.
 */
export type NodeResumedEvent = {
  type: "node:resumed";
  node_id: string;
  wait_id: string;
  event: string;
  reason: "event" | "timeout";
  payload?: unknown;
  waited_ms: number;
  next_node_id: string;
};
