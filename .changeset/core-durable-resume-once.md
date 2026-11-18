---
"@tuttiai/core": patch
---

A durable run that a second runtime on the same session store resumed and finished while its host was paused now rejects with `RUN_SUPERSEDED` when it wakes, instead of writing the session and emitting `agent:end` a second time (#133). The check sees the other run's write only when the store re-reads shared state; `PostgresSessionStore` answers from each process's own cache, so runtimes in separate processes can still both complete.
