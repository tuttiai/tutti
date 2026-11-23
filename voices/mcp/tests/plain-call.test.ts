/**
 * Pins how tools without MCP Tasks are called: one `callTool` with exactly
 * `{ name, arguments }`, no `tasks/*` request, and the same text mapping.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryMcpVoice, plainServer, toolContext } from "./helpers/in-memory.js";

async function connected(): Promise<InMemoryMcpVoice> {
  const voice = new InMemoryMcpVoice(plainServer());
  await voice.setup(toolContext);
  return voice;
}

function toolNamed(voice: InMemoryMcpVoice, name: string) {
  const tool = voice.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("McpVoice plain tool calls", () => {
  it("discovers the server's tools", async () => {
    const voice = await connected();

    expect(voice.tools.map((t) => t.name).sort()).toEqual(["broken", "echo", "silent"]);
    await voice.teardown();
  });

  it("joins the text blocks and skips the others", async () => {
    const voice = await connected();

    const result = await toolNamed(voice, "echo").execute({ text: "hello" }, toolContext);

    expect(result).toEqual({ content: "hello\nsecond", is_error: false });
    await voice.teardown();
  });

  it("returns (no output) when there is no text", async () => {
    const voice = await connected();

    const result = await toolNamed(voice, "silent").execute({}, toolContext);

    expect(result).toEqual({ content: "(no output)", is_error: false });
    await voice.teardown();
  });

  it("passes isError on as is_error", async () => {
    const voice = await connected();

    const result = await toolNamed(voice, "broken").execute({}, toolContext);

    expect(result).toEqual({ content: "bad input", is_error: true });
    await voice.teardown();
  });

  it("calls callTool with exactly { name, arguments } and sends no tasks request", async () => {
    const voice = await connected();
    const callTool = vi.spyOn(Client.prototype, "callTool");

    await toolNamed(voice, "echo").execute({ text: "hello" }, toolContext);

    expect(callTool).toHaveBeenCalledOnce();
    expect(callTool.mock.calls[0]).toEqual([{ name: "echo", arguments: { text: "hello" } }]);
    expect(voice.sent.filter((m) => m.startsWith("tasks/"))).toEqual([]);
    expect(voice.sent).toContain("tools/call");
    await voice.teardown();
  });

  it("returns an error result when the server is gone", async () => {
    const voice = await connected();
    const tool = toolNamed(voice, "echo");
    await voice.teardown();

    const result = await tool.execute({ text: "hello" }, toolContext);

    expect(result).toEqual({ content: "MCP client not connected", is_error: true });
  });
});
