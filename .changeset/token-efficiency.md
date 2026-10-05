---
"@tuttiai/types": minor
"@tuttiai/core": minor
"@tuttiai/telemetry": minor
"@tuttiai/server": minor
---

Fewer tokens per run. `ClaudeCodeProvider` resumes the Claude Code session that holds a conversation and sends only the new messages, so its prompt cache is read instead of rewritten every turn (`reuse_sessions: false` restores the old behaviour). `AnthropicProvider` sets prompt-cache breakpoints. `TokenUsage` gains optional `cache_read_input_tokens` and `cache_creation_input_tokens`, carried through `AgentResult.usage`, telemetry spans and `estimateCost`. New `AgentConfig.context` caps tool results, shortens older ones and summarises long conversations; the server image reads it from `TUTTI_MAX_TOOL_RESULT_CHARS`, `TUTTI_TRIM_AFTER_TOKENS` and `TUTTI_SUMMARISE_AFTER_TOKENS`. Semantic memory is searched once per run rather than every turn.
