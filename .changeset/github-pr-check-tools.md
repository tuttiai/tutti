---
"@tuttiai/github": minor
"@tuttiai/cli": patch
---

Add `list_pull_request_checks` and `get_check_run_log` to the GitHub voice, so an agent that opens a pull request can see whether CI passed and, when it did not, why.

`list_pull_request_checks` takes `owner`, `repo` and `pr_number`, resolves the pull request's head commit and lists every check run on it (name, status, conclusion, start and completion times, link, `check_run_id`, and the output title and summary, truncated) and every commit status, opening with one overall line such as `Overall: 3 passed, 1 failed, 0 pending, 0 skipped (verdict: failing)`. The verdict is `green` only when at least one check exists and none failed or is still running.

`get_check_run_log` takes `owner`, `repo`, `check_run_id` and an optional `tail_lines` (default 150, at most 1000), downloads that GitHub Actions job's log and returns only its last lines, capped at 40,000 characters. A check run from another app, an expired log, a job still running and a token without Actions read access each come back as an error with a hint.

Both are read-only and not destructive. `GitHubVoice` now exposes 15 tools; its constructor and options are unchanged. `tutti-ai search`'s built-in tool count for `github` moves from 13 to 15.
