# @tuttiai/core

## [Unreleased]

### Minor Changes

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
