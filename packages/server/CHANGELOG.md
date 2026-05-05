# @tuttiai/server

## [Unreleased]

### Minor Changes

- New `/cost/*` route family for the CLI's cost-analysis commands (`analyze`, `report`, `budgets`):
  - `GET /cost/runs?since=&until=&agent_id=&limit=` — list run-cost records from the runtime's `RunCostStore`. Returns `{ store_missing: true, runs: [] }` when no store is configured so the CLI can render a friendly "configure a RunCostStore" message instead of 500-ing.
  - `GET /cost/budgets?agent_id=` — per-agent `BudgetConfig` from the score plus `daily_total_usd` / `monthly_total_usd` from the store. Without an `agent_id`, returns one row per agent.
  - `GET /cost/tools` — aggregates `tool.call` spans from the in-memory tracer's ring buffer into per-tool call counts and (proxy) average LLM tokens per call. Bounded by the tracer's default 1000 spans and lost on server restart, so the response includes `window_started_at` + `window_span_count` for the CLI to render with explicit live-window framing.
- Export `aggregateToolUsage(spans)` — pure helper used by `/cost/tools`, exposed for tests and custom dashboards. 5 new server tests.

## 0.4.0

### Minor Changes

- Add /realtime WebSocket endpoint and /realtime-demo browser demo page

## 0.3.0

### Minor Changes

- Add `/studio/*` static serving, `/studio/events` SSE stream, `/graph` endpoint, `/sessions` and `/sessions/:id/turns` endpoints

## 0.2.0

### Minor Changes

- Add GET /sessions/:id/interrupts, GET /interrupts/pending, POST /interrupts/:id/approve, POST /interrupts/:id/deny endpoints; broadcast interrupt:requested WebSocket event
