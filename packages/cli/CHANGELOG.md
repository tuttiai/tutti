# @tuttiai/cli

## [Unreleased]

### Minor Changes

- Add `--studio` flag to `tutti-ai serve` and rewrite `tutti-ai studio` to mount the new `@tuttiai/studio` Vite/React SPA at `/studio` on the Fastify server. The `studio` command spawns `serve --studio` under the hood and opens the browser after a 1-second delay.
- `tutti-ai serve` now reads an optional `graph` field off the loaded score (a `TuttiGraph` instance or raw `GraphConfig`) and forwards it to the server so `GET /graph` returns the live graph definition. Powers the studio's `GraphCanvas`.
- When `score.graph` is present, `serve` constructs a `TuttiGraph` via `runtime.createGraph(config)` and passes it as `graph_runner` to the server. This makes `POST /run` execute the graph (with live `node:start` / `node:complete` / `node:error` events on `/studio/events`) and is what powers the studio canvas's live execution visualisation.

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
