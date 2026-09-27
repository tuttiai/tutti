import { describe, it, expect, afterEach, vi } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { z } from "zod";
import type { ChatResponse, Tool, Voice } from "@tuttiai/types";

import { DEFAULT_STREAM_HEARTBEAT_MS } from "../src/config.js";
import type { ServerConfig } from "../src/config.js";
import { buildTestServer, textResponse, API_KEY } from "./helpers.js";
import type { TestHarness } from "./helpers.js";
import { parseSSE } from "./sse.js";

/** A voice with one destructive tool, which the framework gates by default. */
function prVoice(): Voice {
  const tool: Tool<{ title: string }> = {
    name: "create_pull_request",
    description: "Open a pull request",
    parameters: z.object({ title: z.string() }),
    destructive: true,
    execute: () => Promise.resolve({ content: "opened #7" }),
  };
  return { name: "test-github", required_permissions: [], tools: [tool] };
}

function toolUse(): ChatResponse {
  return {
    id: "resp-tool",
    content: [{ type: "tool_use", id: "t1", name: "create_pull_request", input: { title: "Fix" } }],
    stop_reason: "tool_use",
    usage: { input_tokens: 5, output_tokens: 3 },
  };
}

async function pausingServer(config: Partial<ServerConfig> = {}): Promise<TestHarness> {
  return buildTestServer([toolUse(), textResponse("Done.")], {
    interruptStore: "memory",
    agent: { voices: [prVoice()] },
    config,
  });
}

/** Resolves with the id of the next interrupt the runtime raises. */
function nextInterrupt(harness: TestHarness): Promise<string> {
  return new Promise((resolve) => {
    const off = harness.runtime.events.on("interrupt:requested", (e) => {
      off();
      resolve(e.interrupt_id);
    });
  });
}

function startStream(harness: TestHarness): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: "POST",
    url: "/run/stream",
    headers: { authorization: `Bearer ${API_KEY}` },
    payload: { input: "open a PR" },
  });
}

function resolveInterrupt(
  harness: TestHarness,
  id: string,
  verdict: "approve" | "deny",
): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: "POST",
    url: `/interrupts/${id}/${verdict}`,
    headers: { authorization: `Bearer ${API_KEY}` },
    payload: verdict === "deny" ? { reason: "not today" } : {},
  });
}

describe("POST /run/stream with a gated tool", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await harness?.app.close();
    harness = undefined;
  });

  it("says it is waiting, and resumes on the same stream when approved", async () => {
    harness = await pausingServer();
    const paused = nextInterrupt(harness);
    const stream = startStream(harness);
    const id = await paused;

    expect((await resolveInterrupt(harness, id, "approve")).statusCode).toBe(200);
    const events = parseSSE((await stream).payload);
    const names = events.map((e) => e.event);

    expect(events.find((e) => e.event === "approval_requested")).toEqual({
      event: "approval_requested",
      interrupt_id: id,
      session_id: expect.any(String),
      tool_name: "create_pull_request",
      tool_args: { title: "Fix" },
    });
    expect(names.indexOf("approval_requested")).toBeLessThan(names.indexOf("tool_result"));
    expect(events.find((e) => e.event === "tool_result")?.is_error).toBeFalsy();
    expect(events.at(-1)).toMatchObject({ event: "run_complete", output: "Done." });
  });

  it("ends with an error frame carrying the denial", async () => {
    harness = await pausingServer();
    const paused = nextInterrupt(harness);
    const stream = startStream(harness);
    const id = await paused;

    expect((await resolveInterrupt(harness, id, "deny")).statusCode).toBe(200);
    const events = parseSSE((await stream).payload);

    expect(events.map((e) => e.event)).not.toContain("run_complete");
    expect(events.at(-1)?.event).toBe("error");
    expect(events.at(-1)?.message).toContain("denied by human reviewer: not today");
  });
});

describe("POST /run/stream heartbeat", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await harness?.app.close();
    harness = undefined;
  });

  /** Pause a run, let `advanceMs` of fake time pass, approve, return the raw body. */
  async function pauseFor(advanceMs: number, config: Partial<ServerConfig> = {}): Promise<string> {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    harness = await pausingServer(config);
    const baseline = vi.getTimerCount();
    const paused = nextInterrupt(harness);
    const stream = startStream(harness);
    const id = await paused;
    vi.advanceTimersByTime(advanceMs);
    await resolveInterrupt(harness, id, "approve");
    const payload = (await stream).payload;
    // The interval is cleared once the stream ends.
    expect(vi.getTimerCount()).toBe(baseline);
    return payload;
  }

  const count = (raw: string): number => raw.split(": heartbeat\n\n").length - 1;

  it("writes a comment every 15 s by default while the run waits", async () => {
    const raw = await pauseFor(DEFAULT_STREAM_HEARTBEAT_MS * 2 + 1);
    expect(DEFAULT_STREAM_HEARTBEAT_MS).toBe(15_000);
    expect(count(raw)).toBe(2);
    // Comments are not frames: every data frame still parses.
    expect(parseSSE(raw).at(-1)?.event).toBe("run_complete");
  });

  it("honours stream_heartbeat_ms", async () => {
    const raw = await pauseFor(5_000, { stream_heartbeat_ms: 1_000 });
    expect(count(raw)).toBe(5);
  });

  it("writes none when stream_heartbeat_ms is 0", async () => {
    const raw = await pauseFor(60_000, { stream_heartbeat_ms: 0 });
    expect(count(raw)).toBe(0);
  });
});
