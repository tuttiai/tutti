import { describe, it, expect } from "vitest";
import { SandboxVoiceConfigSchema } from "../src/index.js";

describe("SandboxVoiceConfigSchema", () => {
  it("accepts a fully narrowed configuration", () => {
    const config = {
      allowed_languages: ["python" as const],
      allowed_packages: ["requests"],
      timeout_ms: 30_000,
      max_file_size_bytes: 1_048_576,
      env: { PYTHONPATH: "/srv" },
      install_timeout_ms: 60_000,
    };
    expect(SandboxVoiceConfigSchema.parse(config)).toEqual(config);
  });

  it("accepts an empty configuration, which is the unrestricted default", () => {
    expect(SandboxVoiceConfigSchema.parse({})).toEqual({});
  });

  it("accepts an empty language list, which permits nothing", () => {
    expect(SandboxVoiceConfigSchema.parse({ allowed_languages: [] })).toEqual({
      allowed_languages: [],
    });
  });

  it("rejects a language the executor cannot run", () => {
    expect(() => SandboxVoiceConfigSchema.parse({ allowed_languages: ["ruby"] })).toThrow();
  });

  it("rejects a negative file size limit", () => {
    expect(() => SandboxVoiceConfigSchema.parse({ max_file_size_bytes: -1 })).toThrow();
  });
});
