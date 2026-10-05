/**
 * Unit tests for {@link ClaudeCodeProvider}.
 *
 * The process runner is injected, so no CLI is ever started. Tests assert the
 * arguments the CLI receives, the mapping of its JSON result onto Tutti's
 * content blocks, and the typed errors for each way a call can fail.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatRequest, StreamChunk } from "@tuttiai/types";

import { ClaudeCodeProvider } from "../src/providers/claude-code.js";
import type { ClaudeCodeInvocation, ClaudeCodeRunResult } from "../src/providers/claude-code-process.js";
import { AuthenticationError, ProviderError, RateLimitError, RunAbortedError } from "../src/errors.js";

const weatherTool = {
  name: "get_weather",
  description: "Current weather for a city.",
  input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};

const baseRequest: ChatRequest = {
  model: "claude-sonnet-5",
  system: "You are a weather agent.",
  messages: [{ role: "user", content: "Weather in Paris?" }],
  tools: [weatherTool],
};

function cliResult(fields: Record<string, unknown>): ClaudeCodeRunResult {
  return {
    exit_code: fields["is_error"] === true ? 1 : 0,
    stdout: JSON.stringify({
      type: "result",
      is_error: false,
      session_id: "sess-1",
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 },
      ...fields,
    }),
    stderr: "",
    timed_out: false,
  };
}

let runner: ReturnType<typeof vi.fn<(invocation: ClaudeCodeInvocation) => Promise<ClaudeCodeRunResult>>>;

function provider(): ClaudeCodeProvider {
  return new ClaudeCodeProvider({ runner, cwd: "/work" });
}

function lastInvocation(): ClaudeCodeInvocation {
  const call = runner.mock.calls.at(-1);
  if (!call) throw new Error("runner was not called");
  return call[0];
}

function argAfter(flag: string): string | undefined {
  const args = lastInvocation().args;
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args.at(index + 1);
}

beforeEach(() => {
  runner = vi.fn<(invocation: ClaudeCodeInvocation) => Promise<ClaudeCodeRunResult>>();
});

describe("ClaudeCodeProvider", () => {
  describe("chat", () => {
    it("runs claude -p as a plain model with every built-in tool off", async () => {
      runner.mockResolvedValue(cliResult({ structured_output: { text: "Hi", tool_calls: [] } }));
      await provider().chat(baseRequest);
      const invocation = lastInvocation();
      expect(invocation.command).toBe("claude");
      expect(invocation.cwd).toBe("/work");
      expect(invocation.args).toContain("-p");
      expect(invocation.args).toContain("--safe-mode");
      expect(invocation.args).toContain("--strict-mcp-config");
      expect(argAfter("--tools")).toBe("");
      expect(argAfter("--model")).toBe("claude-sonnet-5");
      expect(argAfter("--output-format")).toBe("json");
      expect(argAfter("--system-prompt")).toContain("You are a weather agent.");
    });

    it("sends the conversation and the host tools on stdin", async () => {
      runner.mockResolvedValue(cliResult({ structured_output: { text: "Hi", tool_calls: [] } }));
      await provider().chat(baseRequest);
      const stdin = lastInvocation().stdin;
      expect(stdin).toContain('"get_weather"');
      expect(stdin).toContain("Weather in Paris?");
    });

    it("maps a text reply to a text block and end_turn", async () => {
      runner.mockResolvedValue(cliResult({ structured_output: { text: "14°C and raining.", tool_calls: [] } }));
      const response = await provider().chat(baseRequest);
      expect(response.content).toEqual([{ type: "text", text: "14°C and raining." }]);
      expect(response.stop_reason).toBe("end_turn");
      expect(response.id).toBe("sess-1");
    });

    it("maps requested tool calls to tool_use blocks with minted ids", async () => {
      runner.mockResolvedValue(cliResult({
        structured_output: {
          text: "",
          tool_calls: [
            { name: "get_weather", input: { city: "Paris" } },
            { name: "get_weather", input: { city: "Rome" } },
          ],
        },
      }));
      const response = await provider().chat(baseRequest);
      expect(response.stop_reason).toBe("tool_use");
      expect(response.content).toHaveLength(2);
      const ids = response.content.map((block) => (block.type === "tool_use" ? block.id : ""));
      expect(ids[0]).toMatch(/^toolu_cc_/);
      expect(new Set(ids).size).toBe(2);
      expect(response.content[0]).toMatchObject({ type: "tool_use", name: "get_weather", input: { city: "Paris" } });
    });

    it("counts cached input tokens as input, and reports them apart", async () => {
      runner.mockResolvedValue(cliResult({ structured_output: { text: "Hi", tool_calls: [] } }));
      const response = await provider().chat(baseRequest);
      expect(response.usage).toEqual({
        input_tokens: 135,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 5,
      });
    });

    it("rejects a request without a model", async () => {
      await expect(provider().chat({ ...baseRequest, model: undefined })).rejects.toBeInstanceOf(ProviderError);
      expect(runner).not.toHaveBeenCalled();
    });

    it("rejects a reply asking for a tool that was not offered", async () => {
      runner.mockResolvedValue(cliResult({ structured_output: { text: "", tool_calls: [{ name: "rm_rf", input: {} }] } }));
      await expect(provider().chat(baseRequest)).rejects.toThrow(/does not match the tool protocol/);
    });
  });

  describe("session reuse", () => {
    const toolCall = { structured_output: { text: "", tool_calls: [{ name: "get_weather", input: { city: "Paris" } }] } };
    const finalText = { structured_output: { text: "14°C.", tool_calls: [] } };

    async function secondTurn(p: ClaudeCodeProvider): Promise<ChatRequest> {
      runner.mockResolvedValueOnce(cliResult(toolCall));
      const first = await p.chat(baseRequest);
      const id = first.content.find((block) => block.type === "tool_use")?.id ?? "";
      return {
        ...baseRequest,
        messages: [
          ...baseRequest.messages,
          { role: "assistant", content: first.content },
          { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "14°C" }] },
        ],
      };
    }

    it("starts a conversation as a new session with a known id", async () => {
      runner.mockResolvedValue(cliResult(finalText));
      await provider().chat(baseRequest);
      expect(argAfter("--session-id")).toMatch(/^[0-9a-f-]{36}$/);
      expect(lastInvocation().args).not.toContain("--resume");
    });

    it("resumes the session on the next turn and sends only the new messages", async () => {
      const p = provider();
      const next = await secondTurn(p);
      runner.mockResolvedValueOnce(cliResult(finalText));
      await p.chat(next);
      expect(argAfter("--resume")).toBe("sess-1");
      const stdin = lastInvocation().stdin;
      expect(stdin).toContain("# Conversation continues");
      expect(stdin).not.toContain("Weather in Paris?");
      expect(stdin).toContain('"tool":"get_weather"');
    });

    it("sends the whole transcript when the history no longer matches the session", async () => {
      const p = provider();
      const next = await secondTurn(p);
      runner.mockResolvedValueOnce(cliResult(finalText));
      await p.chat({ ...next, messages: [{ role: "user", content: "Rewritten" }, ...next.messages.slice(1)] });
      expect(lastInvocation().args).not.toContain("--resume");
      expect(lastInvocation().stdin).toContain("Rewritten");
    });

    it("starts fresh when the CLI no longer has the session", async () => {
      const p = provider();
      const next = await secondTurn(p);
      runner
        .mockResolvedValueOnce({ exit_code: 1, stdout: "", stderr: "No conversation found with session ID: sess-1\n", timed_out: false })
        .mockResolvedValueOnce(cliResult(finalText));
      const response = await p.chat(next);
      expect(response.content).toEqual([{ type: "text", text: "14°C." }]);
      expect(lastInvocation().args).not.toContain("--resume");
      expect(lastInvocation().stdin).toContain("Weather in Paris?");
    });

    it("never resumes one session twice, so concurrent turns cannot share it", async () => {
      const p = provider();
      const next = await secondTurn(p);
      runner.mockResolvedValue(cliResult(finalText));
      await p.chat(next);
      await p.chat(next);
      expect(lastInvocation().args).not.toContain("--resume");
    });

    it("keeps nothing on disk and sends the whole transcript when reuse is off", async () => {
      const p = new ClaudeCodeProvider({ runner, cwd: "/work", reuse_sessions: false });
      const next = await secondTurn(p);
      runner.mockResolvedValueOnce(cliResult(finalText));
      await p.chat(next);
      expect(lastInvocation().args).toContain("--no-session-persistence");
      expect(lastInvocation().args).not.toContain("--resume");
      expect(lastInvocation().stdin).toContain("Weather in Paris?");
    });
  });

  describe("errors", () => {
    it("reports a missing CLI with an install hint", async () => {
      const spawn_error = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
      runner.mockResolvedValue({ exit_code: null, stdout: "", stderr: "", timed_out: false, spawn_error });
      await expect(provider().chat(baseRequest)).rejects.toThrow(/npm install -g @anthropic-ai\/claude-code/);
    });

    it("reports a timeout", async () => {
      runner.mockResolvedValue({ exit_code: null, stdout: "", stderr: "", timed_out: true });
      await expect(provider().chat(baseRequest)).rejects.toThrow(/did not answer in time/);
    });

    it("maps a 401 to AuthenticationError", async () => {
      runner.mockResolvedValue(cliResult({ is_error: true, api_error_status: 401, result: "Invalid bearer token" }));
      await expect(provider().chat(baseRequest)).rejects.toBeInstanceOf(AuthenticationError);
    });

    it("maps a usage limit to RateLimitError", async () => {
      runner.mockResolvedValue(cliResult({ is_error: true, api_error_status: null, result: "Claude AI usage limit reached" }));
      await expect(provider().chat(baseRequest)).rejects.toBeInstanceOf(RateLimitError);
    });

    it("keeps the status of any other API error", async () => {
      runner.mockResolvedValue(cliResult({ is_error: true, api_error_status: 404, result: "There's an issue with the selected model" }));
      const error: unknown = await provider().chat(baseRequest).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).context).toMatchObject({ status: 404 }); // ProviderError always carries context
    });

    it("redacts secrets from output it cannot parse", async () => {
      runner.mockResolvedValue({
        exit_code: 1,
        stdout: "",
        stderr: "boom sk-ant-abcdefghijklmnopqrstuvwxyz0123",
        timed_out: false,
      });
      const error: unknown = await provider().chat(baseRequest).catch((e: unknown) => e);
      expect(String(error)).toContain("[REDACTED]");
      expect(String(error)).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz0123");
    });
  });

  describe("cancellation", () => {
    it("hands the request's signal to the process runner", async () => {
      runner.mockResolvedValue(cliResult({ structured_output: { text: "Hi", tool_calls: [] } }));
      const controller = new AbortController();
      await provider().chat({ ...baseRequest, signal: controller.signal });
      expect(lastInvocation().signal).toBe(controller.signal);
    });

    it("passes no signal when the request has none", async () => {
      runner.mockResolvedValue(cliResult({ structured_output: { text: "Hi", tool_calls: [] } }));
      await provider().chat(baseRequest);
      expect(lastInvocation()).not.toHaveProperty("signal");
    });

    it("reports a killed process as RunAbortedError, not a retryable ProviderError", async () => {
      runner.mockResolvedValue({ exit_code: null, stdout: "", stderr: "", timed_out: false, aborted: true });
      const error: unknown = await provider().chat(baseRequest).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RunAbortedError);
      expect(error).not.toBeInstanceOf(ProviderError);
    });
  });

  describe("stream", () => {
    it("yields the text, each tool call, then usage", async () => {
      runner.mockResolvedValue(cliResult({
        structured_output: { text: "Checking.", tool_calls: [{ name: "get_weather", input: { city: "Paris" } }] },
      }));
      const chunks: StreamChunk[] = [];
      for await (const chunk of provider().stream(baseRequest)) chunks.push(chunk);
      expect(chunks.map((chunk) => chunk.type)).toEqual(["text", "tool_use", "usage"]);
      expect(chunks.at(-1)).toMatchObject({ stop_reason: "tool_use", usage: { input_tokens: 135 } });
    });
  });
});
