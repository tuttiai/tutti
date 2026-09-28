import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "@tuttiai/types";

/**
 * A tool's parameters as the JSON Schema every provider is sent.
 *
 * Converted with the `openApi3` target, which the Gemini provider's
 * translation relies on, and then made valid for JSON Schema draft 2020-12,
 * which Anthropic validates every tool against. The one place the two
 * disagree is an exclusive bound: OpenAPI 3.0 writes `z.number().positive()`
 * as `{ minimum: 0, exclusiveMinimum: true }`, draft-04's form, and Anthropic
 * refuses the whole request with `input_schema: JSON schema is invalid`. So
 * a single `.positive()` anywhere in a voice made every agent holding it
 * unusable. The bound is rewritten as `{ exclusiveMinimum: 0 }`, which both
 * draft 2020-12 and OpenAPI 3.1 read the same way.
 */

/** A JSON value, as the schema walk sees it. */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Each draft-04 exclusive flag, and the inclusive bound it qualifies. */
const BOUNDS = [
  ["exclusiveMinimum", "minimum"],
  ["exclusiveMaximum", "maximum"],
] as const;

/** A copy of the schema with every exclusive bound in its draft 2020-12 form. */
function normalise(node: Json): Json {
  if (Array.isArray(node)) return node.map(normalise);
  if (node === null || typeof node !== "object") return node;
  const entries = new Map(Object.entries(node).map(([key, value]) => [key, normalise(value)]));
  for (const [exclusive, inclusive] of BOUNDS) {
    const flag = entries.get(exclusive);
    if (typeof flag !== "boolean") continue;
    entries.delete(exclusive);
    const bound = entries.get(inclusive);
    if (flag && typeof bound === "number") {
      entries.set(exclusive, bound);
      entries.delete(inclusive);
    }
  }
  return Object.fromEntries(entries);
}

/**
 * Convert a tool's Zod parameters to the JSON Schema its definition carries.
 *
 * @param parameters - The tool's parameter schema.
 * @returns A JSON Schema object valid under draft 2020-12 and OpenAPI 3.
 *
 * @example
 * toolInputSchema(z.object({ timeout_ms: z.number().int().positive() }));
 * // { type: "object", properties: { timeout_ms: { type: "integer", exclusiveMinimum: 0 } }, ... }
 */
export function toolInputSchema(parameters: Tool["parameters"]): Record<string, unknown> {
  // The one place the Zod variance exception lives, moved here from the two call sites that each carried it.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Zod generic variance: Tool<unknown> vs zodToJsonSchema's expected ZodType<any>
  const converted = zodToJsonSchema(parameters, { target: "openApi3" });
  // Safe: the converter's output is plain JSON by construction, and a JSON round trip can only yield a Json value.
  const schema = JSON.parse(JSON.stringify(converted)) as Json;
  const normalised = normalise(schema);
  return typeof normalised === "object" && normalised !== null && !Array.isArray(normalised) ? normalised : {};
}
