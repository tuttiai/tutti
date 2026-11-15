import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { exportAndCapture, prettyJson } from "./helpers/otlp-capture.js";
import { fixtureSpans } from "./helpers/span-fixtures.js";

/*
 * Pins the OTLP payload the exporter sends in its default mode. The golden
 * file was written against main before the adapter moved, so any change to
 * a default span name, attribute, status or id shows up as a diff here.
 */
describe("OTLPExporter default output (golden)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("serialises every span kind exactly as before", async () => {
    const body = await exportAndCapture(fixtureSpans());
    await expect(prettyJson(body)).toMatchFileSnapshot("./__golden__/otlp-legacy.json");
  });

  it("leaves running spans out of the payload", async () => {
    const body = await exportAndCapture(fixtureSpans());
    const names = body.match(/"name":"(agent|llm|tool|guardrail|checkpoint)[^"]*"/g) ?? [];
    expect(names).toHaveLength(6);
    expect(body).not.toContain("writer");
  });
});
