# @tuttiai/core

## 0.23.1

### Patch Changes

- v0.26.1 — Security patch. Clears the five OpenTelemetry / protobufjs advisories acknowledged in `SECURITY-NOTES-v0.26.0.md`. Bumps `@opentelemetry/sdk-node` `^0.214.0` → `^0.218.0`, `@opentelemetry/auto-instrumentations-node` `^0.72.0` → `^0.76.0`, and `@opentelemetry/exporter-trace-otlp-http` `^0.214.0` → `^0.218.0`. No public-API change — `NodeSDK`, `getNodeAutoInstrumentations`, and `OTLPTraceExporter` constructor signatures in `telemetry-setup.ts` continue to compile and pass the existing tests unchanged. `npm audit --audit-level=high` now reports zero advisories.

## 0.23.0

### Minor Changes

- v0.26.0 — Self-improving skills, serverless runtime, scheduled delivery.

  Skills: `@tuttiai/skills` (new package, 0.1.0) ships the `SkillStore` contract and `InMemorySkillStore` reference. `@tuttiai/core` wires a closed loop around it — `TrajectoryObserver` records every tool call of a successful run, `SkillProposer` asks the score's LLM to synthesise a `SkillCandidate` from a trajectory window with dedupe against prior candidates, `SkillExecutor` projects approved skills into callable tools so the agent invokes them like a voice tool. Permissions for a skill are the union of constituent tools' permissions — checked at run start, not invocation. Gated on `score.skills.enabled` + a supplied `skillStore`; zero runtime cost when off. New events: `skill:candidate_proposed`, `skill:approved`, `skill:rejected`, `skill:invoked`, `skill:trajectory_observed`. CLI surface: `tutti-ai skills list | proposed | review [id] | reject <id> --reason`.

  Serverless runtime: `@tuttiai/deploy` adds `modal` and `daytona` to `DeployTarget`. Modal bundles emit `modal_app.py` running the Tutti Node server inside `node:20-bookworm-slim`, declaring `manifest.secrets` as `modal.Secret.from_name("tutti-<lowercase>")`, surfacing `manifest.env` as `env=`, exposing via `@modal.web_server(port=3000, startup_timeout=120)`. Daytona bundles emit a devcontainer + `.daytona/snapshots.yaml` + `daytona.sh` for always-warm agent envs. New CLI: `tutti-ai deploy verify-hibernate` checks scores against the serverless-hibernation contract. Nightly Modal smoke workflow polls `/health` end-to-end and tears down with `modal app stop`.

  Scheduled delivery: `AgentScheduleConfig` gains optional `deliver` (slack/discord/telegram/email/whatsapp) and `deliver_format` (text/markdown). After each successful scheduled run the engine dispatches the agent's output through the matching voice's shared `forToken` / `forKey` wrapper. Delivery failures are absorbed (`schedule:delivery_failed`) and never crash the timer; success fires `schedule:delivered`. Missing voice packages fail fast at schedule registration with a precise "Install `@tuttiai/<platform>`" error.

  Migration: fully additive — no breaking changes. The `skills` block is opt-in, the `deliver` field is optional, new deploy targets sit alongside the existing four.

  Known: five npm-audit advisories (4 high, 1 moderate) in transitive deps of `@tuttiai/telemetry` (OpenTelemetry SDK / protobufjs chain). Documented in `SECURITY-NOTES-v0.26.0.md`. Clearing them requires an OpenTelemetry SDK breaking-change upgrade, scheduled for v0.26.1.

### Patch Changes

- Updated dependencies [91a045e]
- Updated dependencies
  - @tuttiai/types@0.13.0

## 0.21.0

### Minor Changes

- Add hard cost-budget enforcement and `model: 'auto'` agent-level smart-routing.

  - Per-run, daily, and monthly USD ceilings (`max_cost_usd`, `max_cost_usd_per_day`, `max_cost_usd_per_month`) now throw `BudgetExceededError` instead of soft-stopping. Pre-call check throws when the prior turn already breached any cap; post-call check throws on breach and emits `budget:exceeded` with `scope` (`'run' | 'day' | 'month'`) and `limit`. The configured `warn_at_percent` (default 80) fires `budget:warning` per-scope. Token-based `max_tokens` keeps its original soft-break-and-return semantics.
  - `BudgetExceededError` accepts a structured `{ scope, limit, current, tokens? }` payload and exposes `.scope`, `.limit`, `.current`, `.tokens` as typed fields. The legacy positional constructor still works and defaults `scope` to `'run'`.
  - New `model: 'auto'` agent-level sentinel — when set, the runtime delegates per-call model selection to the score's `SmartProvider` (from `@tuttiai/router`). Throws a clear error at run start when no `SmartProvider` is configured. Mixed-mode scores (one agent on `'auto'`, another on a fixed model) work natively. Cost budgets price each call at the chosen tier, so caps behave identically across fixed-model and auto-routed runs.
  - New `PostgresRunCostStore` backend (idempotent `tutti_run_costs` schema with `(started_at)` index, 90-day default retention swept on every write). Wire via `new TuttiRuntime(score, { runCostStore })`. `TuttiRuntime.runCostStore` exposed as a public readonly getter.
  - `TokenBudget.add(input, output, model_override?)` now accepts a per-call model whose pricing supersedes the construction-time model for that call's cost.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @tuttiai/telemetry@0.4.0
  - @tuttiai/types@0.11.3

## [Unreleased]

### Minor Changes

- Recognise `AgentConfig.model === 'auto'` as an agent-level smart-routing opt-in. The runtime delegates per-call model selection to the score's `SmartProvider` (from `@tuttiai/router`), throws clearly at run start when no SmartProvider is configured, and tags `llm.completion` spans with `auto_routed: true` plus the resolved model. Cost budgets price each call at the chosen tier's rate so `max_cost_usd` behaves the same whether the model is fixed or `'auto'`. Mixed-mode scores (some agents on `'auto'`, others fixed) work without extra wiring.
- `TokenBudget.add(input, output, model_override?)` accepts an optional per-call model override used internally by the runner for `'auto'` runs. Tokens covered by an override are priced at the override rate; remaining tokens fall back to the construction-time model. Existing zero-arg call sites unchanged.
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
