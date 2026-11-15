---
"@tuttiai/core": minor
---

Add an optional `skipped?: boolean` to `ScoreResult`; the similarity scorer sets it to `true` when it skips because `OPENAI_API_KEY` is not set.
