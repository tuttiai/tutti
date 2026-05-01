# @tuttiai/router

Smart model router for [Tutti](https://tutti-ai.com) — picks the cheapest configured LLM that can handle each turn, based on task difficulty, the agent's destructive tools, and the active routing policy.

## Install

```bash
npm install @tuttiai/router
```

Peer dependencies: `@tuttiai/core` and `@tuttiai/types`.

## Status

`v0.1.0` — scaffolding only. The package currently exports types plus the zero-cost `HeuristicClassifier`. The `SmartProvider` (the actual `LLMProvider` implementation that consumes a classifier and dispatches to a tier) lands in a follow-up release.

## Quick start

```typescript
import { HeuristicClassifier } from "@tuttiai/router";

const classifier = new HeuristicClassifier();

const tier = await classifier.classify(
  { messages: [{ role: "user", content: "summarise this paragraph in one line" }] },
  { tiers: [], policy: "cost-optimised" },
);
// tier === "small"
```

## Routing signals

The heuristic combines:

- **Task shape** — keyword regexes for "complex" (refactor, architect, optimise, debug, …) vs "simple" (summarise, translate, classify, …) intents, plus code-fence detection.
- **Length** — character count converted to a rough token estimate.
- **Tool surface** — total tool count plus a *destructive-tool premium*: agents holding destructive tools pay a small quality bias because mistakes are hard to undo.
- **Prior turn** — `previous_stop_reason: "max_tokens"` forces an escalation.
- **Policy** — `cost-optimised`, `balanced`, or `quality-first` shifts the thresholds.

## License

Apache-2.0
