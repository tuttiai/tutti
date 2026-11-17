---
"@tuttiai/core": patch
---

`AgentRouter.runParallelWithSummary` now prices `total_cost_usd` at each agent's model rate from `PRICING`, instead of a fixed $3/$15 per million tokens for every model. A model with no `PRICING` entry is costed at $0, as in `TokenBudget`.
