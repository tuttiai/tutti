import { describe, it, expect } from "vitest";
import { taskMode, unsupportedResult } from "../src/task-support.js";

const withTasks = { tasks: { requests: { tools: { call: {} } } } };

describe("taskMode", () => {
  it.each([
    ["required", withTasks, "task"],
    ["optional", withTasks, "task"],
    ["forbidden", withTasks, "plain"],
    [undefined, withTasks, "plain"],
    ["required", {}, "unsupported"],
    ["optional", {}, "plain"],
    ["forbidden", undefined, "plain"],
    [undefined, undefined, "plain"],
    ["required", { tasks: { requests: {} } }, "unsupported"],
  ] as const)("taskSupport %s with capabilities %j is %s", (taskSupport, caps, mode) => {
    expect(taskMode(caps, taskSupport)).toBe(mode);
  });
});

describe("unsupportedResult", () => {
  it("names the tool and the server and gives a fix hint", () => {
    const result = unsupportedResult("mcp-crawler", "crawl");

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("crawl");
    expect(result.content).toContain("mcp-crawler");
    expect(result.content).toContain("Upgrade the server");
  });
});
