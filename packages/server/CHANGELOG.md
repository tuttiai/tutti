# @tuttiai/server

## [Unreleased]

### Minor Changes

- Add `GET /studio` and `GET /studio/*` static routes to serve the `@tuttiai/studio` SPA when `ServerConfig.studio_dist_dir` is set. The `/studio` subtree is exempt from bearer auth via the new `AuthOptions.public_path_prefixes` option.
- `GET /graph` now returns `{ nodes: [], edges: [] }` (200) instead of 404 when no graph is configured, so polling frontends can render an empty state without special-casing absence. Edge JSON also carries a `has_condition` flag derived from `GraphEdge.condition`, used by the studio canvas to dash conditional edges.
- Add `ServerConfig.graph_runner` (a `TuttiGraph` instance). When set:
  - `POST /run` delegates to `graph_runner.run(input, { session_id })` and returns the same `{ output, session_id, turns, usage, duration_ms }` shape used by agent mode.
  - New `GET /studio/events` SSE route subscribes to `graph_runner.subscribe(...)` and writes execution lifecycle events (`run:start`, `run:complete`, `node:start`, `node:complete`, `node:error`) to every connected client. Heartbeat comment frames every 25 s keep idle proxies from closing.
  - The `/studio` auth bypass kicks in whenever **either** `studio_dist_dir` **or** `graph_runner` is set, so browser `EventSource` (no `Authorization` header) can subscribe.
- Add session history + replay routes for the studio:
  - `GET /sessions` — list sessions seen during this server's lifetime, newest first. Each row carries `id`, `started_at`, `status`, `turn_count` (live), `model` (resolved from `llm:request` events for graph-node agents not in `score.agents`), and `agent_name`. Backed by a new in-process `SessionsRegistry` that subscribes to `agent:start` / `agent:end` / `llm:request` on `runtime.events` — no `@tuttiai/types` change.
  - `GET /sessions/:id/turns` — returns `{ session_id, turns, count }` for the studio's replay timeline.
  - `POST /sessions/:id/replay-from` — body `{ turn_index, input? }`. Truncates `session.messages` to `slice(0, turn_index)` via the in-memory store's `save()`, then reruns through the graph (when configured) or the named agent. Response carries `replayed_from`, `truncated_to`, plus the standard `output` / `session_id` / `turns`.

## 0.2.0

### Minor Changes

- Add GET /sessions/:id/interrupts, GET /interrupts/pending, POST /interrupts/:id/approve, POST /interrupts/:id/deny endpoints; broadcast interrupt:requested WebSocket event
