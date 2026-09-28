---
"@tuttiai/core": minor
"@tuttiai/server": minor
---

Add `ClaudeCodeProvider`, which answers through the locally installed Claude Code CLI (`claude -p`) and its own login, so you can run your own agents on your Claude subscription instead of an API key. Tutti's tools travel through structured output with every Claude Code built-in tool, MCP server, hook and `CLAUDE.md` switched off. The server image selects it with `TUTTI_PROVIDER=claude-code`; build the image with `--build-arg CLAUDE_CODE_VERSION=<version>` to include the CLI.
