import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { genAiSpanNaming } from "../src/semconv/genai-naming.js";
import type { TuttiSpan } from "../src/types.js";
import { exportAndCapture, prettyJson } from "./helpers/otlp-capture.js";
import { fixtureSpans } from "./helpers/span-fixtures.js";

interface OtlpAttr { key: string; value: Record<string, unknown> }
interface OtlpSpan { name: string; attributes: OtlpAttr[]; events: unknown[] }

function exportedSpans(body: string): OtlpSpan[] {
  // The serialiser's OTLP JSON layout; the test fails loudly if it moves.
  const parsed = JSON.parse(body) as {
    resourceSpans: Array<{ scopeSpans: Array<{ spans: OtlpSpan[] }> }>;
  };
  return parsed.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
}

/** OTLP AnyValue back to a plain value: stringValue, intValue, doubleValue, ... */
function plain(attrs: OtlpAttr[]): Record<string, unknown> {
  return Object.fromEntries(attrs.map((a) => {
    const v = Object.values(a.value)[0];
    return [a.key, "intValue" in a.value ? Number(v) : v];
  }));
}

const closed = (): TuttiSpan[] => fixtureSpans().filter((s) => s.status !== "running");

describe("OTLPExporter with semconv genai", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("carries the GenAI names and gen_ai.* attributes unchanged to the wire", async () => {
    const spans = exportedSpans(await exportAndCapture(fixtureSpans(), { semconv: "genai" }));
    const expected = closed().map(genAiSpanNaming);
    expect(spans.map((s) => s.name)).toEqual([
      "invoke_agent assistant", "chat claude-sonnet-4-5", "execute_tool read_file",
      "guardrail", "checkpoint", "execute_tool write_file",
    ]);
    spans.forEach((span, i) => {
      expect(span.name).toBe(expected[i]?.name);
      expect(plain(span.attributes)).toEqual(expected[i]?.attributes);
    });
  });

  it.each([undefined, "legacy" as const])("matches the golden payload with semconv %s", async (semconv) => {
    const body = await exportAndCapture(fixtureSpans(), semconv === undefined ? {} : { semconv });
    await expect(prettyJson(body)).toMatchFileSnapshot("./__golden__/otlp-legacy.json");
  });

  it("sends no prompt, completion or tool content in any attribute or event", async () => {
    const marker = "MARKER-7f3a-content";
    const spans = closed().map((s) => s.kind !== "tool" ? s : {
      ...s, attributes: { ...s.attributes, tool_input: { prompt: marker }, tool_output: `completion ${marker}` },
    });
    const body = await exportAndCapture(spans, { semconv: "genai" });
    expect(body).not.toContain(marker);
    const contentKeys = [
      "gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.system_instructions",
      "gen_ai.tool.call.arguments", "gen_ai.tool.call.result", "gen_ai.prompt",
      "gen_ai.completion", "tool_input", "tool_output",
    ];
    for (const span of exportedSpans(body)) {
      expect(span.events).toEqual([]);
      expect(span.attributes.map((a) => a.key).filter((k) => contentKeys.includes(k))).toEqual([]);
    }
  });
});
