# @tuttiai/github

GitHub voice for [Tutti](https://tutti-ai.com) — gives agents the ability to interact with GitHub repositories, issues, pull requests, branches, and commits.

An agent can take a change all the way to a pull request through the API alone, with no git binary or shell: `create_branch`, then `commit_files`, then `create_pull_request`. All three are marked `destructive: true`, so HITL-enabled runtimes gate each behind human approval. `commit_files` refuses to commit to the repository's default branch, so an agent's changes always arrive through a pull request, and there is deliberately no tool that merges one.

## Install

```bash
npm install @tuttiai/github
```

## Usage

```ts
import { TuttiRuntime, AnthropicProvider, defineScore } from "@tuttiai/core";
import { GitHubVoice } from "@tuttiai/github";

const score = defineScore({
  provider: new AnthropicProvider(),
  agents: {
    assistant: {
      name: "assistant",
      model: "claude-sonnet-4-20250514",
      system_prompt: "You are a helpful assistant with GitHub access.",
      voices: [new GitHubVoice()], // uses GITHUB_TOKEN env var
      permissions: ["network"],
    },
  },
});

const tutti = new TuttiRuntime(score);
const result = await tutti.run("assistant", "List open issues in vercel/next.js");
```

## Authentication

Pass a token directly or set the `GITHUB_TOKEN` environment variable:

```ts
new GitHubVoice({ token: "ghp_..." })
```

Without a token, tools still work for public repos but are limited to 60 requests/hour.

## Tools

| Tool | Description |
|---|---|
| `list_issues` | List issues with state/label filtering |
| `get_issue` | Get full issue details |
| `create_issue` | Create a new issue |
| `comment_on_issue` | Comment on an issue or PR |
| `list_pull_requests` | List PRs with state filtering |
| `get_pull_request` | Get full PR details with diff stats |
| `get_commit` | Read one commit: message, parents and each changed file's patch, capped at 40,000 characters. Read-only. |
| `list_pull_request_checks` | List the check runs and commit statuses on a PR's head commit, with an overall passed/failed/pending count and verdict. Read-only. |
| `get_check_run_log` | Get the last lines (default 150, max 1000, at most 40,000 characters) of a GitHub Actions job's log. Read-only. |
| `rerun_workflow_job` | Re-run one failed, cancelled or timed-out GitHub Actions job. Refuses a job still running or one that passed. Destructive, gated behind HITL. |
| `create_branch` | Create a branch from the default branch or a named one. Destructive, gated behind HITL. |
| `commit_files` | Commit full-content file writes and deletions onto a branch in one commit. Refuses the default branch; at most 100 entries, 1 MB per file. Destructive, gated behind HITL. |
| `edit_file` | Change part of a file on a branch by exact-text replacement, applied to the whole file on the server, and commit it. Each `old_text` must occur exactly once. Refuses the default branch. Destructive, gated behind HITL. |
| `create_pull_request` | Open a PR from an existing branch. Destructive, gated behind HITL. Does not merge. |
| `update_pull_request` | Change a PR's title and/or description. Destructive, gated behind HITL. |
| `update_pull_request_branch` | GitHub's "Update branch": merge the base into the PR's branch. Destructive, gated behind HITL. |
| `mark_ready_for_review` | Take a draft PR out of draft. Destructive, gated behind HITL. |
| `create_review` | Submit a review: `APPROVE`, `REQUEST_CHANGES` or `COMMENT`, with a body. Destructive, gated behind HITL. |
| `get_file_contents` | Read a file one page at a time (`offset`, `limit`, at most 40,000 characters a page). The first line gives the lines returned, the file's total lines and bytes, and whether the read is partial. |
| `search_code` | Search code across repos |
| `list_repositories` | List repos for a user or org |
| `get_repository` | Get full repo details |

## Links

- [Tutti](https://tutti-ai.com)
- [GitHub](https://github.com/tuttiai/tutti/tree/main/voices/github)
- [Voice Registry](https://tutti-ai.com/voices)

## License

Apache 2.0
