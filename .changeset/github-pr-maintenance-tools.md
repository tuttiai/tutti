---
"@tuttiai/github": minor
"@tuttiai/cli": patch
---

Add seven tools to the GitHub voice so an agent can keep a pull request moving without stopping for a person, and page `get_file_contents`.

`edit_file` takes `owner`, `repo`, `branch`, `path`, `message` and `edits` (1 to 50 `{ old_text, new_text }`), reads the whole file at the branch head, applies the replacements in order and commits the result. Each `old_text` must occur exactly once or nothing is committed. It refuses the default branch and never force-updates, as `commit_files` does.

`update_pull_request` changes a pull request's title and/or description. `mark_ready_for_review` takes a draft out of draft. `update_pull_request_branch` merges the base into the pull request's branch, as GitHub's "Update branch" does. `create_review` submits an `APPROVE`, `REQUEST_CHANGES` or `COMMENT` review with a body. `rerun_workflow_job` re-runs a failed, cancelled or timed-out GitHub Actions job by its `check_run_id` and refuses one still running or one that passed. `get_commit` returns one commit's message, parents and per-file patches, capped at 40,000 characters.

`get_file_contents` takes `offset` and `limit` (lines, at most 5,000, and 40,000 characters a page). Every file read now opens with a line giving the lines returned, the total lines and bytes, and whether the read is complete or `PARTIAL` with the next offset. Files over 1 MB are read as blobs instead of coming back empty.

Every new tool that writes is marked `destructive: true`. `GitHubVoice` now exposes 22 tools; its constructor and options are unchanged. `tutti-ai search`'s built-in count for `github` moves from 15 to 22.
