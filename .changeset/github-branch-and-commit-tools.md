---
"@tuttiai/github": minor
---

Add `create_branch` and `commit_files` to the GitHub voice, so an agent can put a change on a branch through the GitHub API with no git binary or shell, then open a pull request with `create_pull_request`.

`create_branch` takes `owner`, `repo`, `branch` and an optional `from`, which defaults to the repository's default branch. A branch that already exists comes back as an error pointing at `commit_files`.

`commit_files` takes `owner`, `repo`, `branch`, `message`, `files` (each a `path` and its full new UTF-8 `content`) and `deletions`, and writes them as one commit through the Git Data API. The branch is fast-forwarded and never force-updated, so a branch that moved meanwhile is reported and left alone. Every path is checked before any request is made: absolute paths, `..`, backslashes, empty segments, anything inside `.git` and duplicates are refused, as are an empty change set, more than 100 entries and content over 1 MB. It refuses to commit to the repository's default branch, so an agent's change always arrives through a pull request.

Both are marked `destructive: true` and gate on human approval by default. `GitHubVoice` now exposes 13 tools; its constructor and options are unchanged.
