# @tuttiai/studio

## 0.1.0

### Minor Changes

- Initial release. Vite + React SPA mounted at `/studio/*` by `@tuttiai/server`.
- **Three-panel layout**: header `RunBar` posts user input to `POST /run`; left sidebar lists Agents/Graphs (placeholder) and Sessions history; centre is tabbed (Graph | Replay); right panel shows the active session summary or a node inspector.
- **GraphCanvas**: live TuttiGraph visualisation built on `@xyflow/react` with dagre top-down layout. Polls `GET /graph` every 5 s. Color-codes entrypoint / regular / `__end__` nodes; conditional edges rendered dashed.
- **Live execution overlay**: `useExecutionStream` subscribes to `GET /studio/events` via `EventSource`. Nodes pulse blue while `running`, switch to a green border + duration badge on `node:complete`, red on `node:error`. Traversed edges highlight blue after `run:complete`.
- **Session history + time-travel replay**: `SessionsList` polls `GET /sessions`. `ReplayView` loads turns via `GET /sessions/:id/turns`, renders a per-turn timeline with expandable tool-call / tool-result cards, ←/→ keyboard nav, JSON/Markdown export, and a "Replay from here" button that calls `POST /sessions/:id/replay-from` and flips back to the Graph tab so the rerun plays out live.
