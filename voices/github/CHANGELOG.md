# @tuttiai/github

## 0.2.0

### Minor Changes

- 689ffce: Add `create_pull_request` to the GitHub voice.

  The voice could read pull requests but not open one, so any agent workflow ending in a PR had to leave the voice and shell out to `gh`. The new tool takes `owner`, `repo`, `title`, `head`, `base` and optional `body`, `draft` and `maintainer_can_modify`, and opens a PR from a branch that already exists. It neither creates the branch nor pushes commits; an empty or missing `head` comes back as a 422 with a fix hint rather than an exception.

  Marked `destructive: true`, matching every other outward-facing write in the catalogue, so HITL-enabled runtimes gate it behind approval by default. No merge tool is provided, deliberately.

  `GitHubVoice` now exposes 11 tools. Its constructor and options are unchanged.
