import { describe, it, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import { RunAbortedError } from "@tuttiai/core";
import type { ChatResponse, Tool, Voice } from "@tuttiai/types";

import type { ServerConfig } from "../src/config.js";
import { buildTestServer, textResponse, API_KEY } from "./helpers.js";
import type { TestHarness } from "./helpers.js";

/**
 * A caller that stops waiting aborts its run.
 *
 * tutti-app's control plane once gave up on a reply and the agent carried on
 * for a minute, asking for two more destructive approvals that nobody was
 * listening for. Each case pauses a run on a gated tool, has the caller leave,
 * and checks the run ends without the tool ever running. Disconnects go over
 * a loopback listener, since `app.inject` cannot drop a socket; no request
 * leaves the machine.
 */

const execute = vi.fn<Tool<{ title: string }>["execute"]>(() => Promise.resolve({ content: "opened #7" }));

function prVoice(): Voice {
  const tool: Tool<{ title: string }> = {
    name: "create_pull_request",
    description: "Open a pull request",
    parameters: z.object({ title: z.string() }),
    destructive: true,
    execute,
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

function pausingServer(config: Partial<ServerConfig> = {}): Promise<TestHarness> {
  return buildTestServer([toolUse(), textResponse("Done.")], {
    interruptStore: "memory",
    agent: { voices: [prVoice()] },
    config,
  });
}

function nextInterrupt(harness: TestHarness): Promise<string> {
  return new Promise((resolve) => {
    const off = harness.runtime.events.on("interrupt:requested", (e) => {
      off();
      resolve(e.interrupt_id);
    });
  });
}

/** The promise of the first run the route starts. */
function firstRun(spy: { mock: { results: { value: unknown }[] } }): Promise<unknown> {
  const value = spy.mock.results[0]?.value;
  if (!(value instanceof Promise)) throw new Error("runtime.run was not called");
  return value;
}

/** POST to a real socket and drop the connection once the run is waiting. */
async function leaveWhilePaused(harness: TestHarness, path: string): Promise<string> {
  const address = await harness.app.listen({ port: 0, host: "127.0.0.1" });
  const client = new AbortController();
  const paused = nextInterrupt(harness);
  const response = fetch(`${address}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ input: "open a PR" }),
    signal: client.signal,
  });
  // Read to the end, so the abort surfaces whether or not headers had arrived.
  const body = (async (): Promise<string> => (await response).text())();
  const id = await paused;
  client.abort();
  await expect(body).rejects.toThrow();
  return id;
}

describe("a caller that stops waiting", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    execute.mockClear();
    await harness?.app.close();
    harness = undefined;
  });

  it("aborts a /run/stream run when the client disconnects", async () => {
    harness = await pausingServer();
    const run = vi.spyOn(harness.runtime, "run");

    const id = await leaveWhilePaused(harness, "/run/stream");

    await expect(firstRun(run)).rejects.toBeInstanceOf(RunAbortedError);
    await expect(firstRun(run)).rejects.toMatchObject({ reason: "client disconnected" });
    expect(execute).not.toHaveBeenCalled();
    const store = harness.interruptStore;
    await vi.waitFor(async () => {
      expect((await store?.get(id))?.status).toBe("denied");
    });
  });

  it("aborts a /run run when the client disconnects", async () => {
    harness = await pausingServer();
    const run = vi.spyOn(harness.runtime, "run");

    await leaveWhilePaused(harness, "/run");

    await expect(firstRun(run)).rejects.toMatchObject({ reason: "client disconnected" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("aborts a /run run that timed out", async () => {
    harness = await pausingServer({ timeout_ms: 50 });
    const run = vi.spyOn(harness.runtime, "run");

    const res = await harness.app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "open a PR" },
    });

    expect(res.statusCode).toBe(504);
    await expect(firstRun(run)).rejects.toMatchObject({ reason: "timed out" });
    expect(execute).not.toHaveBeenCalled();
  });
});
