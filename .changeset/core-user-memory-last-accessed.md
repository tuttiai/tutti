---
"@tuttiai/core": patch
---

`PostgresUserMemoryStore.get` and `search` now return the `last_accessed_at` they just set, instead of the value read before the update.
