---
"@tuttiai/types": minor
"@tuttiai/core": minor
"@tuttiai/server": minor
"@tuttiai/sandbox": patch
---

A run can name the conversation it belongs to, and the sandbox keeps one directory per conversation instead of one per session.

`POST /run` and `POST /run/stream` accept an optional `conversation_id` (1 to 128 characters of `A-Z a-z 0-9 _ -`), passed through `AgentRunOptions.conversation_id` to every voice's `setup()` as the new optional `VoiceContext.conversation_id`. The sandbox keys its working directory by it when it is present and by `session_id` when it is not, so a caller that gives each reply a session of its own no longer hands the agent an empty directory on every reply. Requests without the field behave exactly as before.
