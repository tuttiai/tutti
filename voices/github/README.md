# @tuttiai/github

GitHub voice for [Tutti](https://tutti-ai.com) — gives agents the ability to interact with GitHub repositories, issues, and pull requests.

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
| `get_file_contents` | Read a file from a repo |
| `search_code` | Search code across repos |
| `list_repositories` | List repos for a user or org |
| `get_repository` | Get full repo details |

## Links

- [Tutti](https://tutti-ai.com)
- [GitHub](https://github.com/tuttiai/tutti/tree/main/voices/github)
- [Voice Registry](https://tutti-ai.com/voices)

## License

Apache 2.0
