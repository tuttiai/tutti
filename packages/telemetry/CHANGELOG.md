# @tuttiai/telemetry

## [Unreleased]

### Minor Changes

- Add `RunCostStore` interface and `InMemoryRunCostStore` backend for persisting per-run USD spend, plus `getDailyCost(store, now?)` and `getMonthlyCost(store, now?)` aggregation helpers (UTC calendar buckets). Used by `@tuttiai/core` to enforce `BudgetConfig.max_cost_usd_per_day` / `_per_month`. Postgres backend lives in `@tuttiai/core` (`PostgresRunCostStore`) so this package stays free of `pg`.
- Export `RunCostRecord`, `RunCostStore`, `startOfUtcDay`, `startOfUtcMonth` alongside the new helpers.

## 0.2.0

### Minor Changes

- Add built-in OpenTelemetry-compatible tracing with auto-instrumentation, cost tracking, CLI traces TUI, and OTLP/JSON export
