---
"@tuttiai/core": patch
---

An agent stopped by `max_tool_calls` or `max_turns` is asked for its answer instead of returning nothing.

Reaching either limit broke out of the loop right after the agent asked for more tools, and the run's output is the text of the last assistant message, which was that tool call. So a run could spend sixteen turns and a million tokens and return an empty string. When a run ends that way, the runner now makes one more call asking the agent to answer from what it already found and to say what it could not check. The tools stay on that request, since a provider refuses a history holding tool calls without their definitions, and the request asks in words that none be called. Its tokens count in the run's usage. A run that answered within its limits makes no extra call.
