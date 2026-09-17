import { describe, it, expect } from "vitest";
import { FilesystemVoiceConfigSchema } from "../src/index.js";

describe("FilesystemVoiceConfigSchema", () => {
  it("accepts an empty configuration, which is the only valid one", () => {
    expect(FilesystemVoiceConfigSchema.parse({})).toEqual({});
  });

  it("rejects any key at all, because the voice takes no configuration", () => {
    expect(() => FilesystemVoiceConfigSchema.parse({ root: "/tmp" })).toThrow();
  });
});
