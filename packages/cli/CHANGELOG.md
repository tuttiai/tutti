# @tuttiai/cli

## [Unreleased]

### Minor Changes

- New cost-analysis commands that talk to a running `tutti-ai serve` process:
  - `tutti-ai analyze costs [--last 7d|<N>h] [--agent <id>]` — top runs by cost, daily-spend unicode sparkline, and burn-rate optimisation hints (compares daily average against each agent's `max_cost_usd_per_month`).
  - `tutti-ai report costs [--last 7d|30d] [--agent <id>] [--format text|json|csv]` — exportable cost report; CSV is suitable for spreadsheets and billing tools.
  - `tutti-ai budgets [--agent <id>]` — per-agent budget config and current daily/monthly spend with percentage-of-budget figures.
- Sparkline is hand-rolled unicode (`▁▂▃▄▅▆▇█`); no new runtime dep.
- Pure render helpers in `cost-render.ts` (mirrors `traces-render.ts` pattern) so formatting and hint logic stay unit-tested without HTTP. 29 new render tests.

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
