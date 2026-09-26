/**
 * A mock provider for proving that concurrent runs on one runtime stay
 * apart. Each run's output is derived from its own input (its "tag"),
 * and a rendezvous holds every run at each step until all of them have
 * reached it, so their events are guaranteed to interleave.
 */

import { z } from "zod";
import type {
  ChatMessage,
  ChatRequest,
  LLMProvider,
  StreamChunk,
  Tool,
  Voice,
} from "@tuttiai/types";

/** Resolves once `parties` callers have arrived at the same named phase. */
export type Rendezvous = (phase: string) => Promise<void>;

interface Phase {
  arrived: number;
  release: () => void;
  reached: Promise<void>;
}

/** Build a {@link Rendezvous} for `parties` concurrent runs. */
export function createRendezvous(parties: number): Rendezvous {
  const phases = new Map<string, Phase>();
  return (name) => {
    let phase = phases.get(name);
    if (!phase) {
      let release = (): void => {};
      const reached = new Promise<void>((resolve) => {
        release = resolve;
      });
      phase = { arrived: 0, release, reached };
      phases.set(name, phase);
    }
    phase.arrived += 1;
    if (phase.arrived >= parties) phase.release();
    return phase.reached;
  };
}

/** The first plain-text user message is the run's input, used as its tag. */
function tagOf(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user" && typeof m.content === "string");
  return typeof first?.content === "string" ? first.content : "untagged";
}

function hasToolResult(messages: ChatMessage[]): boolean {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"),
  );
}

/** How the tagged provider behaves once a run reaches it. */
export type TaggedMode = "tool-then-text" | "hang-after-partial";

async function* toolThenText(
  request: ChatRequest,
  meet: Rendezvous,
): AsyncGenerator<StreamChunk> {
  const tag = tagOf(request.messages);
  const usage = { input_tokens: 1, output_tokens: 1 };
  if (!hasToolResult(request.messages)) {
    yield { type: "text", text: `${tag}:thinking ` };
    await meet("turn-1");
    yield { type: "tool_use", tool: { id: `call-${tag}`, name: "echo", input: { tag } } };
    yield { type: "usage", usage, stop_reason: "tool_use" };
    return;
  }
  yield { type: "text", text: `${tag}:a ` };
  await meet("turn-2");
  yield { type: "text", text: `${tag}:b` };
  yield { type: "usage", usage, stop_reason: "end_turn" };
}

async function* hangAfterPartial(
  request: ChatRequest,
  meet: Rendezvous,
): AsyncGenerator<StreamChunk> {
  yield { type: "text", text: `${tagOf(request.messages)}:partial` };
  await meet("partial");
  // Never settles, so the route's timeout is what ends the request.
  await new Promise<never>(() => {});
}

/** A streaming provider whose output names the run that asked for it. */
export function createTaggedProvider(mode: TaggedMode, meet: Rendezvous): LLMProvider {
  return {
    chat: () => Promise.reject(new Error("tagged provider only streams")),
    stream: (request) =>
      mode === "tool-then-text" ? toolThenText(request, meet) : hangAfterPartial(request, meet),
  };
}

/** A voice with one `echo` tool that also waits at the rendezvous. */
export function createEchoVoice(meet: Rendezvous): Voice {
  const echo: Tool<{ tag: string }> = {
    name: "echo",
    description: "Echo the run's tag back",
    parameters: z.object({ tag: z.string() }),
    execute: async ({ tag }) => {
      await meet("tool");
      return { content: `echo:${tag}` };
    },
  };
  return { name: "echo-voice", required_permissions: [], tools: [echo] };
}
