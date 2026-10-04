---
"@tuttiai/types": minor
"@tuttiai/core": minor
---

A run can be cancelled. `AgentRunOptions.signal` takes an `AbortSignal`, and once it aborts the runner makes no further model call and runs no further tool: it checks before every turn and every tool call, ends a wait for human approval (withdrawing the interrupt as denied, reason `run aborted`), and rejects with the new `RunAbortedError` (`code: "RUN_ABORTED"`). The signal reaches the provider as the new optional `ChatRequest.signal`: `ClaudeCodeProvider` kills its `claude -p` process, and `AnthropicProvider` and `OpenAIProvider` cancel the HTTP request. A cancelled call is never retried.
