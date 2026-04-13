/**
 * Parallel agent execution example.
 *
 * Two independent analysts (bull and bear) evaluate the same input
 * simultaneously via `AgentRouter.runParallel()`. The example prints
 * each analyst's answer plus rollup timing and token usage so you can
 * see that concurrent execution wins over sequential.
 */

import { AgentRouter, AnthropicProvider, defineScore } from "@tuttiai/core";

const score = defineScore({
  name: "parallel-analysts",
  provider: new AnthropicProvider(),
  default_model: "claude-sonnet-4-20250514",
  // Declarative parallel entry: `router.run(input)` fans out to both analysts.
  entry: { type: "parallel", agents: ["bull", "bear"] },
  agents: {
    bull: {
      name: "Bull Analyst",
      role: "specialist",
      system_prompt: `You are an optimistic equity analyst. Given a company or asset,
respond in 2-3 sentences with the strongest bullish case. Be concrete and punchy.`,
      voices: [],
    },
    bear: {
      name: "Bear Analyst",
      role: "specialist",
      system_prompt: `You are a skeptical equity analyst. Given a company or asset,
respond in 2-3 sentences with the strongest bearish case. Be concrete and punchy.`,
      voices: [],
    },
  },
});

const router = new AgentRouter(score);

// Observe parallel lifecycle.
router.events.on("parallel:start", (e) => {
  console.log(`[parallel:start] dispatching to: ${e.agents.join(", ")}`);
});
router.events.on("parallel:complete", (e) => {
  console.log(`[parallel:complete] finished: ${e.results.join(", ")}`);
});

const topic = "Apple (AAPL) at current valuation";

console.log(`\n${"=".repeat(60)}`);
console.log(`TOPIC: ${topic}`);
console.log("=".repeat(60));

// Low-level API: per-agent results + rollup metrics.
const summary = await router.runParallelWithSummary(
  [
    { agent_id: "bull", input: topic },
    { agent_id: "bear", input: topic },
  ],
  { timeout_ms: 30_000 },
);

for (const [agentId, result] of summary.results) {
  console.log(`\n── ${agentId.toUpperCase()} ──`);
  console.log(result.output);
  console.log(
    `  turns: ${result.turns} | tokens: ${result.usage.input_tokens + result.usage.output_tokens}`,
  );
}

console.log(`\n${"─".repeat(60)}`);
console.log(
  `TOTALS  duration=${summary.duration_ms}ms` +
    `  tokens=${summary.total_usage.input_tokens + summary.total_usage.output_tokens}` +
    `  cost=$${summary.total_cost_usd.toFixed(4)}`,
);
console.log("─".repeat(60));
