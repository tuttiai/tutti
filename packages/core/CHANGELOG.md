# @tuttiai/core

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
