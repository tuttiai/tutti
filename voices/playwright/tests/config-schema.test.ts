import { describe, it, expect } from "vitest";
import { PlaywrightVoiceConfigSchema } from "../src/index.js";

describe("PlaywrightVoiceConfigSchema", () => {
  it("accepts a full configuration", () => {
    const config = { headless: false, slowMo: 250, timeout: 10_000 };
    expect(PlaywrightVoiceConfigSchema.parse(config)).toEqual(config);
  });

  it("accepts an empty configuration", () => {
    expect(PlaywrightVoiceConfigSchema.parse({})).toEqual({});
  });

  it("accepts a slowMo of zero, which means no delay", () => {
    expect(PlaywrightVoiceConfigSchema.parse({ slowMo: 0 })).toEqual({ slowMo: 0 });
  });

  it("rejects a negative slowMo", () => {
    expect(() => PlaywrightVoiceConfigSchema.parse({ slowMo: -1 })).toThrow();
  });

  it("rejects a zero timeout, which would fail every action", () => {
    expect(() => PlaywrightVoiceConfigSchema.parse({ timeout: 0 })).toThrow();
  });
});
