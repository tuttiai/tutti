import { describe, it, expect } from "vitest";
import { PostgresVoiceConfigSchema } from "../src/index.js";

describe("PostgresVoiceConfigSchema", () => {
  it("accepts a full configuration", () => {
    const config = {
      connection_string: "postgres://u:p@h:5432/db",
      statement_timeout_ms: 30_000,
      max_connections: 5,
    };
    expect(PostgresVoiceConfigSchema.parse(config)).toEqual(config);
  });

  it("accepts an empty configuration, because the connection string falls back to the environment", () => {
    expect(PostgresVoiceConfigSchema.parse({})).toEqual({});
  });

  it("rejects a non-positive statement timeout", () => {
    expect(() => PostgresVoiceConfigSchema.parse({ statement_timeout_ms: 0 })).toThrow();
  });

  it("rejects a fractional connection count", () => {
    expect(() => PostgresVoiceConfigSchema.parse({ max_connections: 2.5 })).toThrow();
  });

  it("rejects poolFactory, which is a test seam and not serialisable", () => {
    expect(() => PostgresVoiceConfigSchema.parse({ poolFactory: "anything" })).toThrow();
  });
});
