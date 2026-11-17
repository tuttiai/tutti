import { z } from "zod";

/**
 * Convert an MCP tool's JSON Schema `inputSchema` to a Zod schema. Covers the
 * common shapes: objects of strings, numbers, integers, booleans, arrays,
 * nested objects and string enums. Anything else becomes `z.unknown()`.
 *
 * @param schema - The tool's `inputSchema`.
 * @returns A Zod schema that keeps unknown keys.
 */
export function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  // Safe: each property schema is only read through typeof-checked fields below.
  const properties = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((v): v is string => typeof v === "string")
    : [];

  if (!properties) {
    return z.record(z.unknown());
  }

  const shapeMap = new Map<string, z.ZodTypeAny>();
  for (const [key, prop] of Object.entries(properties)) {
    let field: z.ZodTypeAny = convertType(prop);
    if (typeof prop.description === "string") {
      field = field.describe(prop.description);
    }
    if (!required.includes(key)) {
      field = field.optional();
    }
    shapeMap.set(key, field);
  }

  return z.object(Object.fromEntries(shapeMap)).passthrough();
}

function convertType(prop: Record<string, unknown>): z.ZodTypeAny {
  if (Array.isArray(prop.enum)) {
    const strings = prop.enum.filter((v): v is string => typeof v === "string");
    if (strings.length > 0) {
      // Safe: the length check above guarantees at least one element.
      return z.enum(strings as [string, ...string[]]);
    }
  }

  switch (prop.type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(z.unknown());
    case "object":
      return z.record(z.unknown());
    default:
      return z.unknown();
  }
}
