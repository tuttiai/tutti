---
"@tuttiai/github": minor
"@tuttiai/cli": patch
---

Add `merge_pull_request` to the GitHub voice, so an agent team that owns a repository can land its own pull requests once they pass.

It takes `owner`, `repo`, `pr_number`, `expected_head_sha` (required) and `merge_method` (`merge`, the default, `squash` or `rebase`). GitHub merges only at that head, so commits pushed after the agent read the checks are never merged unseen; a moved head comes back as a 409 with a fix hint, and a draft, a conflict or a blocking repository rule as a 405. It does not read CI or reviews itself: deciding a pull request is ready stays with the caller's instructions.

Marked `destructive: true`, so HITL-enabled runtimes gate it behind approval by default. This reverses 0.2.0's "no merge tool" on purpose: the gate, not the absence of the tool, is what keeps merges with a person where they should be. `create_pull_request`'s description now points to it. `GitHubVoice` exposes 23 tools; `tutti-ai search`'s built-in count for `github` moves from 22 to 23.
