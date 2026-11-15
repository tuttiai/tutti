---
"@tuttiai/core": patch
---

A run paused past its session's idle time to live gets its session back under the same id when it finishes, instead of failing with `Session not found` after its tool has run (#131).
