/**
 * A stateless stand-in for the OpenAI chat API on loopback, so the restart
 * test runs the real server image with no network and no API key. It decides
 * from the tool results in each request: write the marker file, then delete
 * it (the gated call), then finish with "done".
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { z } from "zod";

const RequestSchema = z.object({
  stream: z.boolean().optional(),
  messages: z.array(z.object({ role: z.string(), tool_call_id: z.string().optional() }).passthrough()),
});

/** The ids of the two tool calls the fake model makes. */
export const WRITE_CALL = "call_write";
export const DELETE_CALL = "call_delete";

type Step = { kind: "tool"; id: string; name: string; args: string } | { kind: "text"; text: string };

/** A running fake, with the tool result ids of every request it answered. */
export interface FakeOpenAI {
  url: string;
  /** One entry per request: the `tool_call_id`s it carried, in order. */
  requests: string[][];
  close: () => Promise<void>;
}

function nextStep(toolResults: string[]): Step {
  if (toolResults.includes(DELETE_CALL)) return { kind: "text", text: "done" };
  if (toolResults.includes(WRITE_CALL)) {
    return { kind: "tool", id: DELETE_CALL, name: "delete_file", args: JSON.stringify({ path: "marker.txt", require_confirmation: false }) };
  }
  return { kind: "tool", id: WRITE_CALL, name: "write_file", args: JSON.stringify({ path: "marker.txt", content: "x" }) };
}

const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

function message(step: Step): Record<string, unknown> {
  if (step.kind === "text") return { role: "assistant", content: step.text };
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id: step.id, type: "function", function: { name: step.name, arguments: step.args } }],
  };
}

function delta(step: Step): Record<string, unknown> {
  if (step.kind === "text") return { role: "assistant", content: step.text };
  return { role: "assistant", tool_calls: [{ index: 0, id: step.id, type: "function", function: { name: step.name, arguments: step.args } }] };
}

function reply(res: ServerResponse, step: Step, stream: boolean): void {
  const finish_reason = step.kind === "tool" ? "tool_calls" : "stop";
  const base = { id: "chatcmpl-fake", created: 0, model: "fake-model" };
  if (!stream) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: message(step), finish_reason }], usage }));
    return;
  }
  res.setHeader("content-type", "text/event-stream");
  const chunk = (body: Record<string, unknown>): string => `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", ...body })}\n\n`;
  res.write(chunk({ choices: [{ index: 0, delta: delta(step), finish_reason: null }] }));
  res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason }] }));
  res.write(chunk({ choices: [], usage }));
  res.end("data: [DONE]\n\n");
}

async function body(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(Buffer.isBuffer(part) ? part : Buffer.from(String(part)));
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

/**
 * Start the fake on a free loopback port.
 *
 * @returns Its base URL (for `OPENAI_BASE_URL`), the requests seen, and a way to stop it.
 */
export async function startFakeOpenAI(): Promise<FakeOpenAI> {
  const requests: string[][] = [];
  const server: Server = createServer((req, res) => {
    body(req).then((raw) => {
      const parsed = RequestSchema.parse(raw);
      const ids = parsed.messages.flatMap((m) => (m.tool_call_id === undefined ? [] : [m.tool_call_id]));
      requests.push(ids);
      reply(res, nextStep(ids), parsed.stream === true);
    }).catch(() => {
      res.statusCode = 400;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // Safe: a server listening on a TCP port reports an AddressInfo, not a pipe name.
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
