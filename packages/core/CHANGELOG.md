# @tuttiai/core

## [Unreleased]

### Minor Changes

- Add hard cost-budget enforcement to the agent runtime. `BudgetConfig.max_cost_usd` now throws `BudgetExceededError` (instead of soft-stopping) when a run's accumulated cost crosses the cap; `max_cost_usd_per_day` and `max_cost_usd_per_month` (new in `@tuttiai/types`) are enforced the same way against a `RunCostStore` snapshot taken at run start. The configured `warn_at_percent` (default 80) emits `budget:warning` per scope. Token-based `max_tokens` keeps its existing soft-break-and-return semantics.
- Add `PostgresRunCostStore` (mirrors `PostgresCheckpointStore`): idempotent `tutti_run_costs` schema, `(started_at)` index, 90-day default retention swept on every write. Wire via `new TuttiRuntime(score, { runCostStore })`; required for daily/monthly enforcement in multi-process deployments.
- Re-export `InMemoryRunCostStore`, `getDailyCost`, `getMonthlyCost`, `RunCostStore`, `RunCostRecord` from `@tuttiai/telemetry` for one-stop importing.
- `BudgetExceededError` accepts a structured `{ scope, limit, current, tokens? }` payload and exposes `.scope`, `.limit`, `.current`, `.tokens` as typed fields. The legacy positional constructor (`tokens, costUsd, limit: string`) still works and defaults `scope` to `'run'`.
- `TuttiRuntimeOptions` gains optional `runCostStore`. When omitted, daily/monthly budgets log a one-time warning per run and skip enforcement (the per-run cap still applies).
- `TuttiRuntime.runCostStore` exposed as a public readonly getter so `@tuttiai/server` can serve `/cost/runs` and `/cost/budgets` without reaching into the runner.
- `RunCostStore` interface gains `list({ since?, until?, agent_name?, limit?, order? })` for the CLI's `analyze` / `report` aggregation. Implemented on both `InMemoryRunCostStore` (filter+sort in memory) and `PostgresRunCostStore` (parameterised SQL using the existing `started_at` index). Additive — existing call sites unaffected.
- Add `TuttiGraph.subscribe(handler)` for receiving the same `GraphEvent`s `stream()` yields, without holding an async iterator open. Multiple subscribers are supported; a throwing subscriber is logged and the run continues. Also exposes `GraphEventHandler` from the package root.
- Add `TuttiRuntime.createGraph(config)` factory — constructs a `TuttiGraph` bound to the runtime's private `AgentRunner`, so score authors don't have to thread the runner manually.
- `GraphEvent` now includes a new `node:error` variant (with `node_id`, `error`, `duration_ms`) emitted before a node failure propagates. `node:end` carries `duration_ms`. Every event is stamped with `session_id` when one was passed via `RunOptions.session_id`.

### Patch Changes

- `graphToJSON` now exposes `has_condition` on each serialised edge (derived from `GraphEdge.condition`) so visualisation frontends can render conditional edges differently. The function value itself remains stripped — only the boolean flag is emitted.

## 0.20.1

### Patch Changes

- Add DeployConfig to AgentConfig schema
- Updated dependencies
  - @tuttiai/types@0.11.1

## 0.18.0

### Minor Changes

- Add golden dataset eval system: GoldenStore, ExactScorer, SimilarityScorer, ToolSequenceScorer, CustomScorer, and GoldenRun runner

## 0.17.0

### Minor Changes

- Add requireApproval config for human-in-the-loop: glob-pattern tool gating, interrupt/approve/deny lifecycle, Postgres and in-memory interrupt stores

## 0.16.0

### Minor Changes

- Add user-scoped persistent memory with Postgres and in-memory backends; auto-inject relevant memories into system prompt; autoInfer extracts memories from conversation

## 0.15.0

### Minor Changes

- Auto-instrument agent runs, tool calls, LLM completions, and guardrails with TuttiTracer; attach trace_id and usage summary to RunResult

### Patch Changes

- Updated dependencies
  - @tuttiai/telemetry@0.2.0
