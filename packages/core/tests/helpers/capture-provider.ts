/**
 * A mock provider that records what the model was sent at each call.
 *
 * `createMockProvider` keeps a reference to the request, and the runner
 * keeps appending to the same `messages` array, so `chat.mock.calls` shows
 * the conversation as it ended rather than as the model saw it. This
 * provider serialises each request at the moment it is made.
 */

import type { ChatRequest, ChatResponse, LLMProvider } from "@tuttiai/types";
import { createMockProvider } from "./mock-provider.js";

/** A provider together with the requests it has received so far. */
export interface CaptureProvider {
  /** Pass this to `AgentRunner`. */
  readonly provider: LLMProvider;
  /** `JSON.stringify` of each request, in call order. */
  readonly sent: string[];
}

/**
 * Build a provider that replies in order and captures every request as JSON.
 *
 * @param responses - Replies returned in order, as for `createMockProvider`.
 * @returns The provider and the list it records into.
 */
export function createCaptureProvider(responses: ChatResponse[]): CaptureProvider {
  const queue = [...responses];
  const sent: string[] = [];
  const provider: LLMProvider = {
    stream: createMockProvider(responses).stream,
    chat: async (request: ChatRequest): Promise<ChatResponse> => {
      sent.push(JSON.stringify(request));
      const next = queue.shift();
      if (!next) throw new Error("No more mock responses");
      return next;
    },
  };
  return { provider, sent };
}
