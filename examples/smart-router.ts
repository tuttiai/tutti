/**
 * Smart model routing — picks the cheapest tier per turn.
 *
 * Run three prompts of increasing complexity and watch the router
 * choose different tiers. Requires ANTHROPIC_API_KEY (and OPENAI_API_KEY
 * if you want the fallback tier to ever fire).
 */

import { TuttiRuntime, AnthropicProvider, OpenAIProvider, defineScore } from "@tuttiai/core";
import { SmartProvider } from "@tuttiai/router";

const score = defineScore({
  provider: new SmartProvider({
    tiers: [
      { tier: "small", provider: new AnthropicProvider(), model: "claude-haiku-4-5-20251001" },
      { tier: "medium", provider: new AnthropicProvider(), model: "claude-sonnet-4-6" },
      { tier: "large", provider: new AnthropicProvider(), model: "claude-opus-4-7" },
      { tier: "fallback", provider: new OpenAIProvider(), model: "gpt-4o-mini" },
    ],
    classifier: "heuristic",
    policy: "cost-optimised",
    max_cost_per_run_usd: 0.1,
  }),
  agents: {
    assistant: {
      name: "assistant",
      system_prompt: "You are a helpful assistant.",
      voices: [],
    },
  },
});

const runtime = new TuttiRuntime(score);

runtime.events.on("router:decision", (e) =>
  console.log(
    `→ routed to ${e.model} (tier=${e.tier}, ~$${e.estimated_cost_usd.toFixed(5)}) — ${e.reason}`,
  ),
);
runtime.events.on("router:fallback", (e) =>
  console.log(`⚠ fallback ${e.from_model} → ${e.to_model}: ${e.error}`),
);

const inputs = [
  "Summarise this in one line: The quick brown fox jumped over the lazy dog.",
  "Refactor this TypeScript function to be more performant: function dedupe(a:string[]){return Array.from(new Set(a))}",
  "Design a CRDT-based distributed counter with conflict resolution. Walk through the algorithm step by step.",
];

for (const input of inputs) {
  const result = await runtime.run("assistant", input);
  console.log("OUTPUT:", result.output.slice(0, 80), "…\n");
}
