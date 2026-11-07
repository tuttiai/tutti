import { describe, it, expect } from "vitest";
import {
  parseRegistryBody,
  parseRegistryResponse,
  REGISTRY_LIMITS,
} from "../src/registry-response.js";

const entry = {
  name: "postgres",
  package: "@tuttiai/postgres",
  description: "Query and inspect a PostgreSQL database",
  tags: ["postgres", "sql"],
};

function withEntry(overrides: Record<string, unknown>): unknown {
  return { official: [{ ...entry, ...overrides }] };
}

function errorOf(data: unknown): string | undefined {
  const result = parseRegistryResponse(data);
  return result.success ? undefined : result.error;
}

describe("parseRegistryResponse", () => {
  it("accepts the live registry shape and drops unknown keys", () => {
    const result = parseRegistryResponse({
      $schema: "./voices.schema.json",
      official: [{ ...entry, tools_count: 8, repo: "x", version: "0.1.1", permissions: ["network"] }],
      community: [],
    });

    expect(result).toEqual({
      success: true,
      data: { official: [{ ...entry, tools_count: 8 }], community: [] },
    });
  });

  it("keeps a string tools_count such as dynamic", () => {
    const result = parseRegistryResponse(withEntry({ tools_count: "dynamic" }));

    expect(result.success && result.data.official[0]?.tools_count).toBe("dynamic");
  });

  it("treats a missing list as empty", () => {
    const result = parseRegistryResponse({ community: [entry] });

    expect(result).toEqual({ success: true, data: { official: [], community: [entry] } });
  });

  it.each([
    [[], "(root): expected an object"],
    [null, "(root): expected an object"],
    ["voices", "(root): expected an object"],
    [{ $schema: "x" }, "(root): expected official or community"],
    [{ official: "x" }, "official: expected an array"],
    [{ community: {} }, "community: expected an array"],
    [{ official: [42] }, "official[0]: expected an object"],
  ])("rejects the shape %j", (data, error) => {
    expect(errorOf(data)).toBe(error);
  });

  it.each([
    [{ name: 5 }, "official[0].name: expected a string of at most 64 characters"],
    [{ package: undefined }, "official[0].package: expected a string of at most 214 characters"],
    [{ description: null }, "official[0].description: expected a string of at most 500 characters"],
    [{ tags: "a" }, "official[0].tags: expected at most 20 strings of at most 50 characters"],
    [{ tags: [1] }, "official[0].tags: expected at most 20 strings of at most 50 characters"],
  ])("rejects the field %j", (overrides, error) => {
    expect(errorOf(withEntry(overrides))).toBe(error);
  });

  it.each([true, -1, 1.5, 1001, {}, "x".repeat(33)])("rejects tools_count %j", (value) => {
    expect(errorOf(withEntry({ tools_count: value }))).toBe(
      "official[0].tools_count: expected an integer from 0 to 1000 or a string of at most 32 characters",
    );
  });

  it.each([0, 1000, "x".repeat(32)])("accepts tools_count %j at the bound", (value) => {
    expect(errorOf(withEntry({ tools_count: value }))).toBeUndefined();
  });

  it("rejects the whole payload when one entry of several is invalid", () => {
    expect(errorOf({ official: [entry, { ...entry, name: 5 }] })).toBe(
      "official[1].name: expected a string of at most 64 characters",
    );
  });

  it.each(["official", "community"] as const)("bounds %s at its limit", (key) => {
    const max = REGISTRY_LIMITS[key];

    expect(errorOf({ [key]: Array.from({ length: max }, () => entry) })).toBeUndefined();
    expect(errorOf({ [key]: Array.from({ length: max + 1 }, () => entry) })).toBe(
      `${key}: expected at most ${max} items`,
    );
  });

  it.each([
    ["name", REGISTRY_LIMITS.name],
    ["package", REGISTRY_LIMITS.package],
    ["description", REGISTRY_LIMITS.description],
  ])("bounds %s at %i characters", (field, max) => {
    expect(errorOf(withEntry({ [field]: "x".repeat(max) }))).toBeUndefined();
    expect(errorOf(withEntry({ [field]: "x".repeat(max + 1) }))).toBe(
      `official[0].${field}: expected a string of at most ${max} characters`,
    );
  });

  it("bounds tags by count and by length", () => {
    const { tags, tag } = REGISTRY_LIMITS;

    expect(errorOf(withEntry({ tags: Array.from({ length: tags }, () => "t") }))).toBeUndefined();
    expect(errorOf(withEntry({ tags: Array.from({ length: tags + 1 }, () => "t") }))).toMatch(/^official\[0\]\.tags:/);
    expect(errorOf(withEntry({ tags: ["x".repeat(tag)] }))).toBeUndefined();
    expect(errorOf(withEntry({ tags: ["x".repeat(tag + 1)] }))).toMatch(/^official\[0\]\.tags:/);
  });

  it("never puts a payload value in the error", () => {
    const hostile = "\u001b[31mghp_secretsecretsecret";
    const error = errorOf(withEntry({ description: hostile.repeat(100) }));

    expect(error).toBeDefined();
    expect(error).not.toContain("ghp_");
    expect(error).not.toContain("\u001b");
  });
});

describe("parseRegistryBody", () => {
  it("decodes and validates a JSON body", () => {
    expect(parseRegistryBody(JSON.stringify({ official: [entry] })).success).toBe(true);
  });

  it.each(["{not json", "", "<html>"])("reports %j as invalid-json", (body) => {
    expect(parseRegistryBody(body)).toEqual({ success: false, error: "invalid-json" });
  });
});
