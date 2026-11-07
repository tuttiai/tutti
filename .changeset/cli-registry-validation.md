---
"@tuttiai/cli": patch
---

`tutti-ai search` and `tutti-ai voices` now validate the voice registry response and fall back to the built-in list, with a warning, when it is malformed, partial or oversized; the registry's `tools_count` is used when present.
