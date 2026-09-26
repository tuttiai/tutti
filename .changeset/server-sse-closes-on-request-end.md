---
"@tuttiai/server": patch
---

`/run/stream`, `/traces/stream`, `/interrupts/stream` and `/studio/events` detect a departed client from the response's `close`, not the request's. Node emits the request's `close` once its body has been read, so every `/run/stream` reply ended before its first frame.
