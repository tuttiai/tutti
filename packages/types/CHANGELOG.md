# @tuttiai/types

## [Unreleased]

### Patch Changes

- `BudgetConfig` gains optional `max_cost_usd_per_day` and `max_cost_usd_per_month`. Enforced by the runtime against a `RunCostStore` (UTC calendar buckets); breaches throw `BudgetExceededError` with `scope: 'day' | 'month'`.
- `budget:warning` and `budget:exceeded` events gain optional `scope: 'run' | 'day' | 'month'` and numeric `limit`. Existing payload fields unchanged.

## 0.11.2

### Patch Changes

- Add `RealtimeAgentConfig` type and `AgentConfig.realtime?: RealtimeAgentConfig | false` field. Mirrors `@tuttiai/realtime`'s `RealtimeConfig` shape so `@tuttiai/types` keeps its zero-runtime-dep invariant (same pattern as `DeployConfig`).

## 0.11.1

### Patch Changes

- Add DeployConfig and DeployTarget types; AgentConfig gains optional deploy field
