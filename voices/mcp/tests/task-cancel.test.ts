/** Tools that support MCP Tasks: abort, timeout and cancel. */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ExperimentalClientTasks } from "@modelcontextprotocol/sdk/experimental/tasks";
import { toolContext } from "./helpers/in-memory.js";
import { POLL_MS } from "./helpers/task-server.js";
import { taskHarness, tick, type TaskHarness } from "./helpers/task-harness.js";
import { callWithTask } from "../src/task-call.js";
import { CANCEL_TIMEOUT_MS } from "../src/task-runner.js";

const HINT = "Retry with a smaller input or raise tool_timeout_ms.";

function count(h: TaskHarness, method: string): number {
  return h.voice.sent.filter((m) => m === method).length;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("McpVoice task cancel", () => {
  it("cancels the task once and stops polling when the run aborts during a poll wait", async () => {
    const h = await taskHarness();
    const cancelTask = vi.spyOn(ExperimentalClientTasks.prototype, "cancelTask");
    const run = h.tool.execute({}, h.context);
    await tick();

    h.controller.abort("client went away");
    const result = await run;
    const polls = count(h, "tasks/get");
    const updates = h.updates.length;
    await tick(POLL_MS * 3);

    expect(result).toEqual({
      content: `MCP task ${h.control.taskId} (crawl on mcp-test) cancelled (run aborted). ${HINT}`,
      is_error: true,
    });
    expect(count(h, "tasks/cancel")).toBe(1);
    expect(cancelTask).toHaveBeenCalledWith(h.control.taskId, { timeout: CANCEL_TIMEOUT_MS });
    expect(count(h, "tasks/get")).toBe(polls);
    expect(h.updates).toHaveLength(updates);
    expect(vi.getTimerCount()).toBe(0);
    await h.voice.teardown();
  });

  it("says the task timed out when the runtime's timeout aborted it", async () => {
    const h = await taskHarness();
    const run = h.tool.execute({}, h.context);
    await tick();

    h.controller.abort(Object.assign(new Error("Tool timed out"), { code: "TOOL_TIMEOUT" }));
    const result = await run;

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("cancelled (timed out)");
    expect(count(h, "tasks/cancel")).toBe(1);
    await h.voice.teardown();
  });

  it("stops the create request when the run aborts before the task exists", async () => {
    const h = await taskHarness();
    h.control.holdCreate = true;
    const run = h.tool.execute({}, h.context);
    await tick();

    h.controller.abort("client went away");
    const result = await run;
    await tick();

    expect(result).toEqual({
      content: `MCP tool crawl on mcp-test cancelled (run aborted). Note: the server had not created the task yet. ${HINT}`,
      is_error: true,
    });
    expect(h.voice.sent).toContain("notifications/cancelled");
    expect(count(h, "tasks/cancel")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await h.voice.teardown();
  });

  it("sends nothing when the run was aborted before the call", async () => {
    const h = await taskHarness();
    h.controller.abort("gone");

    const result = await h.tool.execute({}, h.context);

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("cancelled (run aborted)");
    expect(h.voice.sent).not.toContain("tools/call");
    await h.voice.teardown();
  });

  it("still returns the cancelled result when the server rejects the cancel of an ended task", async () => {
    const h = await taskHarness();
    const run = h.tool.execute({}, h.context);
    await tick();
    await h.control.finish([{ type: "text", text: "done" }]);

    h.controller.abort("client went away");
    const result = await run;

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("cancelled (run aborted). Note: the server did not confirm the cancel");
    expect(count(h, "tasks/cancel")).toBe(1);
    await h.voice.teardown();
  });

  it("still returns the cancelled result when the cancel itself fails", async () => {
    const h = await taskHarness();
    vi.spyOn(ExperimentalClientTasks.prototype, "cancelTask").mockRejectedValue(new Error("connection reset"));
    const run = h.tool.execute({}, h.context);
    await tick();

    h.controller.abort("client went away");
    const result = await run;

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("the server did not confirm the cancel (connection reset)");
    await h.voice.teardown();
  });

  it("returns an error result when the client is gone", async () => {
    const result = await callWithTask(undefined, { server: "mcp-test", name: "crawl", args: {}, mode: "task" }, toolContext);

    expect(result).toEqual({ content: "MCP client not connected", is_error: true });
  });
});
