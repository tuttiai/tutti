# @tuttiai/cli

## 0.23.0

### Minor Changes

- 734010d: Add Daytona as a deploy target — `tutti-ai deploy --target daytona` (or `target: "daytona"` in the score) generates a devcontainer bundle (`.devcontainer/devcontainer.json`, `.daytona/snapshots.yaml`, `.gitignore`, `daytona.sh`) for an always-warm agent dev environment. Forwards port 3000, pins `tutti-ai@latest`, runs `daytona create --no-ide` followed by `daytona ssh -- tutti-ai serve …`.

  Note: the `.daytona/snapshots.yaml` field names (`idle_minutes_until_hibernate`, `auto_resume`) are not verified against the current Daytona schema and the file ships with a TODO banner — hibernation may need to move into `daytona sandbox create` flags in a follow-up.

- v0.26.0 — Self-improving skills, serverless runtime, scheduled delivery.

  Skills: `@tuttiai/skills` (new package, 0.1.0) ships the `SkillStore` contract and `InMemorySkillStore` reference. `@tuttiai/core` wires a closed loop around it — `TrajectoryObserver` records every tool call of a successful run, `SkillProposer` asks the score's LLM to synthesise a `SkillCandidate` from a trajectory window with dedupe against prior candidates, `SkillExecutor` projects approved skills into callable tools so the agent invokes them like a voice tool. Permissions for a skill are the union of constituent tools' permissions — checked at run start, not invocation. Gated on `score.skills.enabled` + a supplied `skillStore`; zero runtime cost when off. New events: `skill:candidate_proposed`, `skill:approved`, `skill:rejected`, `skill:invoked`, `skill:trajectory_observed`. CLI surface: `tutti-ai skills list | proposed | review [id] | reject <id> --reason`.

  Serverless runtime: `@tuttiai/deploy` adds `modal` and `daytona` to `DeployTarget`. Modal bundles emit `modal_app.py` running the Tutti Node server inside `node:20-bookworm-slim`, declaring `manifest.secrets` as `modal.Secret.from_name("tutti-<lowercase>")`, surfacing `manifest.env` as `env=`, exposing via `@modal.web_server(port=3000, startup_timeout=120)`. Daytona bundles emit a devcontainer + `.daytona/snapshots.yaml` + `daytona.sh` for always-warm agent envs. New CLI: `tutti-ai deploy verify-hibernate` checks scores against the serverless-hibernation contract. Nightly Modal smoke workflow polls `/health` end-to-end and tears down with `modal app stop`.

  Scheduled delivery: `AgentScheduleConfig` gains optional `deliver` (slack/discord/telegram/email/whatsapp) and `deliver_format` (text/markdown). After each successful scheduled run the engine dispatches the agent's output through the matching voice's shared `forToken` / `forKey` wrapper. Delivery failures are absorbed (`schedule:delivery_failed`) and never crash the timer; success fires `schedule:delivered`. Missing voice packages fail fast at schedule registration with a precise "Install `@tuttiai/<platform>`" error.

  Migration: fully additive — no breaking changes. The `skills` block is opt-in, the `deliver` field is optional, new deploy targets sit alongside the existing four.

  Known: five npm-audit advisories (4 high, 1 moderate) in transitive deps of `@tuttiai/telemetry` (OpenTelemetry SDK / protobufjs chain). Documented in `SECURITY-NOTES-v0.26.0.md`. Clearing them requires an OpenTelemetry SDK breaking-change upgrade, scheduled for v0.26.1.

### Patch Changes

- Updated dependencies [734010d]
- Updated dependencies [91a045e]
- Updated dependencies
  - @tuttiai/deploy@0.2.0
  - @tuttiai/types@0.13.0
  - @tuttiai/core@0.23.0
  - @tuttiai/inbox@0.2.0

## 0.21.0

### Minor Changes

- Add cost-analysis commands. All three talk to a running `tutti-ai serve` process (HTTP) and read from the runtime's `RunCostStore`:

  - `tutti-ai analyze costs [--last 7d|<N>h] [--agent <id>]` — top runs by cost, daily-spend unicode sparkline, and burn-rate optimisation hints (compares daily average against each agent's `max_cost_usd_per_month`). Includes a "Top tools (live window)" section when `/cost/tools` returns data, plus caching and `model: 'auto'` suggestions when tool-call patterns warrant them.
  - `tutti-ai report costs [--last 7d|30d] [--agent <id>] [--format text|json|csv]` — exportable cost report.
  - `tutti-ai budgets [--agent <id>]` — per-agent budget config and current daily/monthly spend with percentage figures.

  Sparkline is hand-rolled unicode (`▁▂▃▄▅▆▇█`); no new runtime dep.

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @tuttiai/core@0.21.0
  - @tuttiai/server@0.5.0
  - @tuttiai/types@0.11.3

## [Unreleased]

### Minor Changes

- New cost-analysis commands that talk to a running `tutti-ai serve` process:
  - `tutti-ai analyze costs [--last 7d|<N>h] [--agent <id>]` — top runs by cost, daily-spend unicode sparkline, and burn-rate optimisation hints (compares daily average against each agent's `max_cost_usd_per_month`).
  - `tutti-ai report costs [--last 7d|30d] [--agent <id>] [--format text|json|csv]` — exportable cost report; CSV is suitable for spreadsheets and billing tools.
  - `tutti-ai budgets [--agent <id>]` — per-agent budget config and current daily/monthly spend with percentage-of-budget figures.
- Sparkline is hand-rolled unicode (`▁▂▃▄▅▆▇█`); no new runtime dep.
- Pure render helpers in `cost-render.ts` (mirrors `traces-render.ts` pattern) so formatting and hint logic stay unit-tested without HTTP. 36 render tests.
- `analyze costs` now also surfaces a "Top tools (live window)" table when the server's `/cost/tools` route returns data, plus two extra optimisation hints driven by the same data:
  - **Caching hint** — fires when a single tool was called ≥10 times in the live tracer window, suggesting `cache: { enabled: true }`.
  - **`model: 'auto'` hint** — fires when ≥60% of recent tool-driven turns ran on small inputs (avg <800 tokens/call) yet the run cost is non-trivial, cross-promoting the SmartProvider routing path.
    Both sections are explicitly framed as a **live window** ("X spans collected since &lt;timestamp&gt;") so users don't read these counts as authoritative all-time totals — they're bounded by the in-memory tracer ring buffer (default 1000 spans, lost on server restart).

## 0.20.0

### Minor Changes

- Add `tutti-ai studio` command — opens visual agent IDE in browser

### Patch Changes

- Updated dependencies
  - @tuttiai/server@0.3.0

## 0.19.0

### Minor Changes

- Add `tutti-ai deploy` command with dry-run, status, logs, and rollback subcommands

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @tuttiai/core@0.20.1
  - @tuttiai/deploy@0.1.0
  - @tuttiai/types@0.11.1

## 0.17.0

### Minor Changes

- Add `tutti-ai eval record/list/run` commands with CI mode, JUnit XML output, and diff display

### Patch Changes

- Updated dependencies
  - @tuttiai/core@0.18.0

## 0.16.0

### Minor Changes

- Add `tutti-ai interrupts` interactive TUI and approve/deny CLI commands

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @tuttiai/core@0.17.0
  - @tuttiai/server@0.2.0

## 0.15.0

### Minor Changes

- Add `tutti-ai memory` commands for user memory management: list, search, add, delete, clear, export

### Patch Changes

- Updated dependencies
  - @tuttiai/core@0.16.0

## 0.14.0

### Minor Changes

- Add `tutti-ai traces list/show/tail` commands for local trace inspection

### Patch Changes

- Updated dependencies
  - @tuttiai/core@0.15.0
