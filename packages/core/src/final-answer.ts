import type { ChatMessage } from "@tuttiai/types";

/**
 * The answer an agent owes when a limit stops it mid-work.
 *
 * A run ends at `max_tool_calls` or `max_turns` by breaking out of the loop
 * right after the agent asked for more tools, so its last message is a tool
 * call and the run's output, the text of that message, is empty. An agent
 * that had spent sixteen turns and a million tokens reading code returned
 * nothing at all, and the agent that delegated to it had nothing to work
 * with. So one more call is made, asking it to answer from what it already
 * gathered.
 *
 * The tools stay on the request, because a provider refuses a history that
 * holds tool calls without their definitions, and the request says in words
 * not to call them. If the agent calls one anyway, the text beside the call,
 * if any, is the answer.
 */

/** What the agent is told when a limit stops it. */
export const FINAL_ANSWER_REQUEST =
  "You have reached the limit of tool calls or turns for this run, so no more tools will run. " +
  "Do not call any tool. Write your final answer now, from what you have already found, " +
  "and say plainly what you could not check.";

/**
 * Whether a run stopped mid-work: its last message is the tool results of a
 * turn the agent never got to answer.
 *
 * @param messages - The run's messages, in order.
 * @returns True when the last message is a user message holding tool results.
 */
export function stoppedMidWork(messages: readonly ChatMessage[]): boolean {
  const last = messages.at(-1);
  return last?.role === "user" && Array.isArray(last.content) && last.content.some((block) => block.type === "tool_result");
}

/**
 * Ask for the final answer in the same user message as the last tool results,
 * so the history still alternates between the agent and the user.
 *
 * @param messages - The run's messages. The last is replaced; nothing else changes.
 */
export function askForFinalAnswer(messages: ChatMessage[]): void {
  const last = messages.at(-1);
  if (last === undefined || !Array.isArray(last.content)) return;
  messages[messages.length - 1] = { ...last, content: [...last.content, { type: "text", text: FINAL_ANSWER_REQUEST }] };
}
