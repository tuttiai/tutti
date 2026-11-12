/** Tools that support MCP Tasks: results, failures and progress. */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client";
import { toolContext } from "./helpers/in-memory.js";
import { POLL_MS } from "./helpers/task-server.js";
import { taskHarness, tick } from "./helpers/task-harness.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("McpVoice task calls", () => {
  it("creates a task, polls it and returns its result like callTool would", async () => {
    const h = await taskHarness();
    const callTool = vi.spyOn(Client.prototype, "callTool");

    const run = h.tool.execute({}, h.context);
    await tick();
    await h.control.status("page 2 of 4");
    await tick(POLL_MS);
    await h.control.finish([
      { type: "text", text: "hello" },
      { type: "image", data: "aGk=", mimeType: "image/png" },
      { type: "text", text: "second" },
    ]);
    await tick(POLL_MS);

    expect(await run).toEqual({ content: "hello\nsecond", is_error: false });
    expect(callTool).not.toHaveBeenCalled();
    expect(h.voice.sent).toEqual(expect.arrayContaining(["tools/call", "tasks/get", "tasks/result"]));
    expect(h.voice.sent).not.toContain("tasks/cancel");
    expect(vi.getTimerCount()).toBe(0);
    await h.voice.teardown();
  });

  it("runs a required tool as a task", async () => {
    const h = await taskHarness("required");

    const run = h.tool.execute({}, h.context);
    await tick();
    await h.control.finish([]);
    await tick(POLL_MS);

    expect(await run).toEqual({ content: "(no output)", is_error: false });
    await h.voice.teardown();
  });

  it("reports task status and progress notifications, tagged with the task and the voice", async () => {
    const h = await taskHarness();

    const run = h.tool.execute({}, h.context);
    await tick();
    await h.control.status("page 2 of 4");
    await tick(POLL_MS);
    await h.control.finish([{ type: "text", text: "done" }]);
    await tick(POLL_MS);
    await run;

    const id = h.control.taskId;
    expect(h.updates).toContainEqual(expect.objectContaining({ progress: 1, total: 4, message: "page 1 of 4", source: "mcp-test" }));
    expect(h.updates.find((u) => u.status !== undefined)).toMatchObject({ task_id: id, status: "working", source: "mcp-test" });
    expect(h.updates).toContainEqual(expect.objectContaining({ task_id: id, status: "working", message: "page 2 of 4" }));
    expect(h.updates.at(-1)).toMatchObject({ task_id: id, status: "completed" });
    await h.voice.teardown();
  });

  it("works on a runtime that gives no signal or progress reporter", async () => {
    const h = await taskHarness();

    const run = h.tool.execute({}, toolContext);
    await tick();
    await h.control.finish([{ type: "text", text: "done" }]);
    await tick(POLL_MS);

    expect(await run).toEqual({ content: "done", is_error: false });
    await h.voice.teardown();
  });

  it("passes a result's isError on as is_error", async () => {
    const h = await taskHarness();

    const run = h.tool.execute({}, h.context);
    await tick();
    await h.control.finish([{ type: "text", text: "bad url" }], true);
    await tick(POLL_MS);

    expect(await run).toEqual({ content: "bad url", is_error: true });
    await h.voice.teardown();
  });

  it("returns the server's status message when the task fails", async () => {
    const h = await taskHarness();

    const run = h.tool.execute({}, h.context);
    await tick();
    await h.control.fail("disk full");
    await tick(POLL_MS);
    const result = await run;

    expect(result.is_error).toBe(true);
    expect(result.content).toContain(`MCP task ${h.control.taskId} (crawl on mcp-test) failed: disk full`);
    expect(result.content).toContain("retry");
    await h.voice.teardown();
  });

  it("returns an error result when tasks/get fails", async () => {
    const h = await taskHarness();

    const run = h.tool.execute({}, h.context);
    await tick();
    h.control.breakGet = true;
    await tick(POLL_MS);
    const result = await run;

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("task store offline");
    await h.voice.teardown();
  });

  it("returns an error result when the server reports an unknown status", async () => {
    const h = await taskHarness();

    const run = h.tool.execute({}, h.context);
    await tick();
    h.control.fakeStatus = "exploded";
    await tick(POLL_MS);
    const result = await run;

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("failed");
    await h.voice.teardown();
  });

  it("caps a long server status message in the result", async () => {
    const h = await taskHarness();

    const run = h.tool.execute({}, h.context);
    await tick();
    await h.control.fail("x".repeat(5000));
    await tick(POLL_MS);
    const result = await run;

    expect(result.content).not.toContain("x".repeat(501));
    expect(result.content.length).toBeLessThan(800);
    await h.voice.teardown();
  });

  it("refuses a required tool on a server without tasks, before sending anything", async () => {
    const h = await taskHarness("required", false);

    const result = await h.tool.execute({}, h.context);

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("requires MCP Tasks");
    expect(h.voice.sent).not.toContain("tools/call");
    await h.voice.teardown();
  });

  it("calls an optional tool on a server without tasks through plain callTool", async () => {
    const h = await taskHarness("optional", false);
    const callTool = vi.spyOn(Client.prototype, "callTool");

    await h.tool.execute({}, h.context);

    expect(callTool.mock.calls).toEqual([[{ name: "crawl", arguments: {} }]]);
    expect(h.voice.sent.filter((m) => m.startsWith("tasks/"))).toEqual([]);
    await h.voice.teardown();
  });
});
