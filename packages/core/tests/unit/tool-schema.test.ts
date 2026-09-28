import { describe, expect, it } from "vitest";
import { z } from "zod";

import { toolInputSchema } from "../../src/tool-schema.js";

/** The web voice's `fetch_url` parameters, whose `.positive()` Anthropic refused. */
const FETCH_URL = z.object({
  url: z.string().url().describe("URL to fetch"),
  timeout_ms: z.number().int().positive().optional().describe("HTTP timeout in ms"),
});

/** Every key of a schema, at any depth. */
function keysOf(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(keysOf);
  if (node === null || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, value]) => [key, ...keysOf(value)]);
}

describe("toolInputSchema", () => {
  it("writes an exclusive lower bound as a number, the form draft 2020-12 accepts", () => {
    const schema = toolInputSchema(FETCH_URL);
    expect(schema).toMatchObject({ properties: { timeout_ms: { type: "integer", exclusiveMinimum: 0 } } });
    expect(schema).not.toHaveProperty("properties.timeout_ms.minimum");
  });

  it("writes an exclusive upper bound the same way", () => {
    expect(toolInputSchema(z.object({ ratio: z.number().lt(1) }))).toMatchObject({ properties: { ratio: { exclusiveMaximum: 1 } } });
  });

  it("leaves inclusive bounds as they are", () => {
    const schema = toolInputSchema(z.object({ limit: z.number().int().min(1).max(20) }));
    expect(schema).toMatchObject({ properties: { limit: { minimum: 1, maximum: 20 } } });
    expect(keysOf(schema)).not.toContain("exclusiveMinimum");
  });

  it("leaves no boolean exclusive bound anywhere, however deep", () => {
    const nested = z.object({ pages: z.array(z.object({ size: z.number().positive(), weight: z.number().negative() })) });
    const schema = toolInputSchema(nested);
    expect(JSON.stringify(schema)).not.toMatch(/"exclusive(Minimum|Maximum)":(true|false)/);
    expect(schema).toMatchObject({ properties: { pages: { items: { properties: { size: { exclusiveMinimum: 0 }, weight: { exclusiveMaximum: 0 } } } } } });
  });

  it("keeps the OpenAPI shape the Gemini translation reads: an object with properties and required", () => {
    const schema = toolInputSchema(FETCH_URL);
    expect(schema).toMatchObject({ type: "object", required: ["url"] });
    expect(schema).not.toHaveProperty("$schema");
  });
});
