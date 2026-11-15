---
"@tuttiai/core": patch
---

Keep a run's spent cost in its approval pause checkpoint (`SessionState.cost_usd_used`) and carry it on when the run resumes, so a `max_cost_usd` ceiling no longer starts again from zero after an approval. Checkpoints saved by earlier versions resume with cost counted from zero.
