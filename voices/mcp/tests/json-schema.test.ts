import { describe, it, expect } from "vitest";
import { jsonSchemaToZod } from "../src/json-schema.js";

describe("jsonSchemaToZod", () => {
  it("accepts any record when there are no properties", () => {
    expect(jsonSchemaToZod({}).parse({ a: 1 })).toEqual({ a: 1 });
  });

  it("converts each property type and keeps unknown keys", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        name: { type: "string", description: "A name" },
        size: { type: "number" },
        count: { type: "integer" },
        on: { type: "boolean" },
        tags: { type: "array" },
        meta: { type: "object" },
        mode: { enum: ["fast", "slow"] },
        anything: {},
      },
      required: ["name"],
    });

    const input = { name: "a", size: 1.5, count: 2, on: true, tags: [1], meta: {}, mode: "fast", anything: null, extra: 1 };
    expect(schema.parse(input)).toEqual(input);
  });

  it("rejects a missing required field and a wrong type", () => {
    const schema = jsonSchemaToZod({ properties: { name: { type: "string" }, count: { type: "integer" } }, required: ["name"] });

    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ name: "a", count: 1.5 }).success).toBe(false);
  });

  it("falls back to the declared type when an enum has no strings", () => {
    const schema = jsonSchemaToZod({ properties: { level: { type: "number", enum: [1, 2] } }, required: ["level"] });

    expect(schema.parse({ level: 3 })).toEqual({ level: 3 });
  });
});
