---
"@tuttiai/core": patch
---

A durable run that a second runtime resumed and finished while its host was paused now rejects with `RUN_SUPERSEDED` when it wakes, instead of writing the session and emitting `agent:end` a second time (#133).
