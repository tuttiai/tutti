import { afterEach, describe, expect, it, vi } from "vitest";

import { OTLPExporter, type OTLPExporterOptions } from "../src/exporters/otlp.js";
import { genAiSpanNaming } from "../src/semconv/genai-naming.js";
import { resolveSpanNaming } from "../src/semconv/mode.js";
import { legacySpanNaming } from "../src/semconv/naming.js";

describe("resolveSpanNaming", () => {
  it("defaults to legacy when the mode is unset", () => {
    expect(resolveSpanNaming(undefined, "X")).toBe(legacySpanNaming);
  });

  it("returns the strategy for each mode", () => {
    expect(resolveSpanNaming("legacy", "X")).toBe(legacySpanNaming);
    expect(resolveSpanNaming("genai", "X")).toBe(genAiSpanNaming);
  });

  it.each([
    ["GENAI", 'X: semconv must be "legacy" or "genai", got "GENAI"'],
    ["", 'X: semconv must be "legacy" or "genai", got ""'],
    [42, 'X: semconv must be "legacy" or "genai", got number'],
    [null, 'X: semconv must be "legacy" or "genai", got object'],
  ])("throws on %j instead of falling back", (mode, message) => {
    expect(() => resolveSpanNaming(mode, "X")).toThrow(message);
  });
});

describe("OTLPExporter semconv option", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects an unknown value before starting its flush timer", () => {
    vi.useFakeTimers();
    // Deliberately invalid at runtime: the constructor's own check is what is
    // under test, so the type check is bypassed here on purpose.
    const opts = JSON.parse(
      '{"endpoint":"http://collector.test","semconv":"otel"}',
    ) as unknown as OTLPExporterOptions;
    expect(() => new OTLPExporter(opts)).toThrow(
      'OTLPExporter: semconv must be "legacy" or "genai", got "otel"',
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
