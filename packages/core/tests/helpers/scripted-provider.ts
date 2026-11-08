/**
 * A provider scripted per agent, for delegation tests. Each request is
 * matched to the script whose key its system prompt contains, so a parent,
 * its specialists and theirs each get their own queue of steps whatever the
 * order the runtime calls them in.
 */

import type { ChatRequest, ChatResponse, LLMProvider, StreamChunk, ToolUseBlock } from "@tuttiai/types";

/** One scripted model call. */
export type ScriptStep =
  | {
      /** Streamed one chunk at a time, or returned joined by `chat`. */
      text: string[];
      /** Called before chunk `index` is yielded. */
      onChunk?: (index: number) => void;
      /** Called after the last chunk, before the stream ends. */
      onEnd?: () => void;
      /** Throw this message after yielding that many chunks. */
      failAfter?: { chunks: number; message: string };
    }
  | { tools: Omit<ToolUseBlock, "type">[] };

const usage = { input_tokens: 10, output_tokens: 5 };

function toResponse(step: ScriptStep): ChatResponse {
  if ("tools" in step) {
    const content = step.tools.map((t) => ({ type: "tool_use" as const, ...t }));
    return { id: "resp", content, stop_reason: "tool_use", usage };
  }
  return { id: "resp", content: [{ type: "text", text: step.text.join("") }], stop_reason: "end_turn", usage };
}

async function* streamStep(step: ScriptStep): AsyncGenerator<StreamChunk> {
  if ("tools" in step) {
    for (const tool of step.tools) yield { type: "tool_use", tool };
    yield { type: "usage", usage, stop_reason: "tool_use" };
    return;
  }
  for (const [index, text] of step.text.entries()) {
    if (step.failAfter?.chunks === index) throw new Error(step.failAfter.message);
    step.onChunk?.(index);
    yield { type: "text", text };
  }
  step.onEnd?.();
  yield { type: "usage", usage, stop_reason: "end_turn" };
}

/**
 * Build a provider that answers each agent from its own script.
 *
 * @param scripts - Steps keyed by a marker found in the agent's system prompt.
 */
export function createScriptedProvider(scripts: Record<string, ScriptStep[]>): LLMProvider {
  const queues = new Map(Object.entries(scripts).map(([k, v]) => [k, [...v]]));
  const next = (request: ChatRequest): ScriptStep => {
    const system = request.system ?? "";
    const queue = [...queues.entries()].find(([key]) => system.includes(key))?.[1];
    const step = queue?.shift();
    if (!step) throw new Error(`No scripted step left for system prompt: ${system.slice(0, 40)}`);
    return step;
  };
  return {
    chat: async (request) => toResponse(next(request)),
    stream: (request) => streamStep(next(request)),
  };
}
