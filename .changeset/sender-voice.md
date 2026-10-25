---
"@tuttiai/sender": minor
"@tuttiai/server": minor
---

Add `@tuttiai/sender`, a voice for Sender (sender.net) email marketing, and register it in the stock server image.

It exposes 14 tools over the Sender v2 REST API with bearer-token auth (`api_key`, falling back to `SENDER_API_KEY`): `list_groups`, `list_subscribers`, `get_subscriber`, `list_campaigns`, `get_campaign`, `create_subscriber`, `update_subscriber`, `create_group`, `add_subscriber_to_group`, `remove_subscriber_from_group`, `create_campaign`, `send_campaign`, `schedule_campaign` and `delete_subscriber`. `create_campaign` only ever creates a draft. `send_campaign`, `schedule_campaign` and `delete_subscriber` are `destructive: true`, so HITL-enabled runtimes gate them behind approval. No new third-party dependency: it uses global `fetch` and `zod`.
