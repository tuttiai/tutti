# @tuttiai/studio

## [Unreleased]

### Minor Changes

- Add `GraphCanvas` — live TuttiGraph visualization built on `@xyflow/react` with dagre top-down layout. Polls `GET /graph` every 5 s, color-codes entrypoint / regular / `__end__` nodes, dashes conditional edges, and routes node clicks into the right-panel inspector.
- Live execution overlay: `useExecutionStream` subscribes to `GET /studio/events` (SSE) and feeds a single `ExecutionState` snapshot into the canvas. Nodes animate a pulsing blue ring while `running`, switch to a green border + duration badge on `node:complete`, and a red border on `node:error`. After `run:complete` the traversed edges are highlighted in blue.
- Header `RunBar` posts user input to `POST /run`; the right-panel `SessionPanel` shows live session id, status, current node, elapsed time, and (post-run) the visited path. The inspector pane shows per-node output / error when a node is selected during or after a run.
- Session history + time-travel replay:
  - New `SessionsList` in the left sidebar (under Agents/Graphs) polls `GET /sessions` every 5 s and ticks on every run-state change. Each row shows agent name, short id, turn count, status dot, and a relative timestamp.
  - New `ReplayView` (center panel) loads turns via `GET /sessions/:id/turns`. Top timeline has one role-coloured dot per turn; the body shows the focused turn with text content, expandable tool-call/tool-result cards, and a token count. Left/Right arrow keys navigate.
  - "Replay from here" calls `POST /sessions/:id/replay-from`, then automatically switches the centre panel back to the Graph tab so the rerun plays out live on the canvas.
  - Export buttons download the conversation as JSON or Markdown via a `Blob`-based helper in `src/replay-export.ts`.
  - Centre panel now has a `Graph | Replay` tab switcher. The Replay tab is disabled until the user picks a session in the sidebar.

## 0.1.0

### Minor Changes

- Initial scaffold — Vite + React SPA shell with three-panel layout (sidebar, graph canvas placeholder, inspector). Served by `@tuttiai/server` at `/studio/*`.
