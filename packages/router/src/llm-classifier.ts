/**
 * LLM-backed classifier — asks a small, cheap model to label the difficulty
 * of each turn before routing. More accurate than {@link HeuristicClassifier}
 * for ambiguous prompts, but adds one extra LLM call per turn.
 */

import type { ChatRequest, LLMProvider } from "@tuttiai/types";
import type { Classifier, ClassifierContext, Tier } from "./types.js";

const SYSTEM = `You classify the difficulty of an LLM task into one of: small, medium, large.
- small: factual lookup, formatting, short summary, single-step
- medium: multi-step reasoning, code generation under 100 lines, tool use up to 3 calls
- large: complex reasoning, refactoring, architecture, long-form writing, math proofs

Respond with ONE WORD only: small, medium, or large.`;

/** Asks `provider.chat` for a one-word difficulty label and maps it to a {@link Tier}. */
export class LLMClassifier implements Classifier {
  /**
   * @param provider - LLM provider used to ask the classification question.
   * @param model - Model identifier passed to `provider.chat`. Should be cheap and fast.
   */
  constructor(
    private provider: LLMProvider,
    private model: string,
  ) {}

  /** Classify `req` by asking the configured provider for a label. Falls back to `'medium'` on any unrecognised reply. */
  async classify(req: ChatRequest, _ctx: ClassifierContext): Promise<Tier> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const text = (typeof lastUser === "string" ? lastUser : JSON.stringify(lastUser)).slice(0, 2000);
    const res = await this.provider.chat({
      model: this.model,
      messages: [{ role: "user", content: text }],
      system: SYSTEM,
      max_tokens: 10,
      temperature: 0,
    });
    // res.content is ContentBlock[] — grab the first text block's payload.
    const firstText = res.content.find((b) => b.type === "text");
    const responseText = firstText?.type === "text" ? firstText.text : "";
    const word = responseText.trim().toLowerCase().split(/\s+/)[0] ?? "";
    if (word === "small" || word === "medium" || word === "large") return word;
    return "medium";
  }
}
