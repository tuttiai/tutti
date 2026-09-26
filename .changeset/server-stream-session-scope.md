---
"@tuttiai/server": patch
"@tuttiai/core": patch
"@tuttiai/types": minor
---

Scope `POST /run/stream` and the `POST /run` timeout reply to the request's own run.

Both routes subscribed to the runtime's shared event bus without filtering, so two concurrent requests on one server received each other's `content_delta`, `tool_call`, `tool_result`, `turn_start` and `turn_end` frames, and a 504's `partial_output` could carry another request's tokens. Filtering by session was not possible: `token:stream`, `tool:start` and `tool:end` name no session, and a request without a `session_id` does not learn its session until the run ends.

Each route now runs `runtime.run` inside an `AsyncLocalStorage` scope and its subscriber only accepts events emitted from that scope. The event bus calls handlers synchronously, so the emitting run is always identifiable, including graph runs whose nodes each open their own session. No change to the signature of `runtime.run` or to the SSE frame shapes.

`token:stream` now carries the run's `session_id`, so other subscribers can tell concurrent runs apart too.
