# @tuttiai/telemetry

## 0.4.0

### Minor Changes

- Add `RunCostStore` interface, `InMemoryRunCostStore`, and the `getDailyCost(store, now?)` / `getMonthlyCost(store, now?)` aggregation helpers (UTC calendar buckets). Pairs with the new daily/monthly budget enforcement in `@tuttiai/core`. Exported alongside the existing `getRunCost`. The interface stays here (zero infra deps); the Postgres backend lives in `@tuttiai/core` for the same reason `PostgresCheckpointStore` does.

  `RunCostStore` gains `list({ since?, until?, agent_name?, limit?, order? })` for cost-analysis aggregation, on both `InMemoryRunCostStore` and `PostgresRunCostStore`. Additive interface change.

  `TuttiSpanAttributes` gains optional `auto_routed: boolean`, set on `llm.completion` spans for calls that originated from a `model: 'auto'` agent.

## [Unreleased]

### Minor Changes

- `TuttiSpanAttributes` gains optional `auto_routed: boolean` — set on `llm.completion` spans for calls from agents with `model: 'auto'`. Lets dashboards split score-level `SmartProvider` use from per-agent opt-in.
- Add `RunCostStore` interface and `InMemoryRunCostStore` backend for persisting per-run USD spend, plus `getDailyCost(store, now?)` and `getMonthlyCost(store, now?)` aggregation helpers (UTC calendar buckets). Used by `@tuttiai/core` to enforce `BudgetConfig.max_cost_usd_per_day` / `_per_month`. Postgres backend lives in `@tuttiai/core` (`PostgresRunCostStore`) so this package stays free of `pg`.
- `RunCostStore` interface gains `list({ since?, until?, agent_name?, limit?, order? })` for cost-analysis tooling (CLI `analyze` / `report` commands and custom dashboards). New `RunCostQuery` type exported.
- Export `RunCostRecord`, `RunCostStore`, `startOfUtcDay`, `startOfUtcMonth` alongside the new helpers.

## 0.2.0

### Minor Changes

- Add built-in OpenTelemetry-compatible tracing with auto-instrumentation, cost tracking, CLI traces TUI, and OTLP/JSON export
