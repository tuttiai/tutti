# @tuttiai/router

Smart model router for [Tutti](https://tutti-ai.com) — picks the cheapest configured LLM that can handle each turn, based on task difficulty, the agent's destructive tools, and the active routing policy.

```bash
npm install @tuttiai/router
```

Peer dependencies: `@tuttiai/core` and `@tuttiai/types`.

## Quick start

```typescript
import { defineScore, AnthropicProvider } from "@tuttiai/core";
import { SmartProvider } from "@tuttiai/router";

export default defineScore({
  provider: new SmartProvider({
    tiers: [
      { tier: "small",  provider: new AnthropicProvider(), model: "claude-haiku-4-5-20251001" },
      { tier: "medium", provider: new AnthropicProvider(), model: "claude-sonnet-4-6" },
      { tier: "large",  provider: new AnthropicProvider(), model: "claude-opus-4-7" },
    ],
    classifier: "heuristic",
    policy: "cost-optimised",
  }),
  agents: {
    assistant: { name: "assistant", system_prompt: "You are helpful.", voices: [] },
  },
});
```

`SmartProvider` is an `LLMProvider`. It drops in anywhere a provider is accepted — including `defineScore`, per-agent `provider` overrides, and `AgentRunner`'s constructor.

## Classifier strategies

| Classifier | Latency | Cost/call | Accuracy | When to use |
|---|---|---|---|---|
| `heuristic` | ~1ms | $0 | ~70% | Default — input length, code detection, tool count |
| `llm` | ~400ms | ~$0.0001 | ~90% | When accuracy matters — uses Haiku as judge |
| `embedding` | ~50ms | ~$0.00001 | ~80% | High volume — coming in a follow-up |

- **`heuristic`** — pure regex + length + tool-count rules. Zero per-call cost, runs in-process, no network. The right default.
- **`llm`** — asks a small/cheap LLM (configurable via `classifier_provider`, falls back to the configured `small` tier) for a one-word difficulty label per turn. Pay ~$0.0001 to gain ~20pp of accuracy on hard-to-classify prompts.
- **`embedding`** — placeholder, ships in a follow-up release. Will compare the request to a pre-embedded set of difficulty exemplars.

## Routing policies

```ts
new SmartProvider({ tiers, classifier: "heuristic", policy: "cost-optimised" })
```

- **`cost-optimised`** (default) — biases the heuristic thresholds so borderline prompts go to the smaller, cheaper tier.
- **`quality-first`** — biases borderline prompts to the larger tier. Use when correctness > cost (post-incident review, legal text, anything customer-visible).
- **`balanced`** — split the difference. Reasonable when you don't have a strong signal either way.

The policy shifts thresholds; it does not change the API surface or which tiers are available. You can change policy without changing call sites.

## Routing decision signals

The heuristic combines:

- **Input size** — total character count of `messages`, converted to a rough token estimate.
- **Code detection** — fenced code blocks or recognisable function/class signatures bump complexity.
- **Complexity keywords** — regexes for "complex" intents (`refactor`, `architect`, `optimise`, `debug`, `prove`, `derive`, …) vs "simple" intents (`summarise`, `translate`, `classify`, `extract`, …).
- **Tool count** — many tools available → larger surface → bigger model.
- **Destructive tool count** — see below.
- **Turn depth** — late in a long loop, escalate.
- **Previous stop reason** — `previous_stop_reason: "max_tokens"` forces an escalation on the next call.

`SmartProvider.previewDecision(req)` returns a `RoutingDecision` (with `tier`, `model`, `reason`, `classifier`, `estimated_input_tokens`, `estimated_cost_usd`) without dispatching. Useful for tests and dashboards.

## Destructive-tool awareness

Tools in Tutti can declare `destructive: true` (introduced in v0.22.0). The router reads the count of destructive tools loaded on the agent at decision time and applies a quality bias — agents holding `@tuttiai/twitter`, `@tuttiai/stripe`, `@tuttiai/postgres` write tools, etc., are biased toward larger, more capable models because the cost of a mistake is much higher than a few extra cents per call.

`AgentRunner` is the source of truth for the destructive-tool count: it threads the count through `AsyncLocalStorage` so `SmartProvider` sees the right value even when several agents share one runner. The count surfaces on every `router:decision` event as `destructive_tool_count`, so dashboards can correlate routing choices with blast radius.

## Event observability

```ts
runtime.events.on("router:decision", (e) => {
  console.log(`${e.agent_name}: ${e.tier} (${e.model}) — ${e.reason}`);
  console.log(`  classifier=${e.classifier}  ~$${e.estimated_cost_usd.toFixed(5)}`);
  if (e.destructive_tool_count) console.log(`  ⚠ ${e.destructive_tool_count} destructive tools`);
});

runtime.events.on("router:fallback", (e) => {
  console.warn(`fallback ${e.from_model} → ${e.to_model}: ${e.error}`);
});
```

Every decision is also recorded as router span attributes on the existing `llm.completion` (in-process) and `llm.call` (OpenTelemetry) spans — `router_tier`, `router_model`, `router_classifier`, `router_reason`, `router_cost_estimate`, plus `router_fallback_*` keys when a fallback fired. So `tutti-ai traces router <trace-id>` and any OTel collector see the same story.

## Cost ceilings

Two ceilings cooperate:

- **`SmartProvider.max_cost_per_run_usd`** — a hard ceiling on the *router's* cumulative estimated cost across one run. If the next call's projected cost would push the run over, the router silently downgrades to `small` rather than dispatching at the chosen tier.
- **`TokenBudget.max_cost_usd`** (existing in `@tuttiai/core`) — the runtime-level budget. `AgentRunner` calls `TokenBudget.canAfford(estimated_cost_usd)` against the cost reported by `SmartProvider.previewDecision` *before* dispatching. If the budget would be breached, the call is forced onto `small` with `reason: "budget-forced"` rather than letting `check()` flip to `"exceeded"` post-hoc.

In practice: keep `max_cost_per_run_usd` for router-level safety nets and use `TokenBudget` for hard runtime limits. Both downgrade to the smallest tier; only `TokenBudget` aborts the run when even `small` would breach.

## Fallback chain

Add a `fallback` tier to keep the run alive when the primary tier throws:

```ts
new SmartProvider({
  tiers: [
    { tier: "small",    provider: new AnthropicProvider(), model: "claude-haiku-4-5-20251001" },
    { tier: "medium",   provider: new AnthropicProvider(), model: "claude-sonnet-4-6" },
    { tier: "fallback", provider: new OpenAIProvider(),    model: "gpt-4o-mini" },
  ],
  classifier: "heuristic",
})
```

When the chosen tier's `chat` throws, `SmartProvider` retries on the fallback, emits `router:fallback`, and records a second `RoutingDecision` with `reason: "fallback after error: …"`. Streaming has no fallback path because chunks may already have been yielded to the consumer.

## License

Apache-2.0.
