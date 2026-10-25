# @tuttiai/sender

Sender voice for [Tutti](https://tutti-ai.com) — manage a [Sender](https://www.sender.net) (sender.net) email marketing account from agents: subscribers, groups and campaigns.

`create_campaign` only ever creates a **draft**. The three tools that email real people or delete data are marked `destructive: true`, so HITL-enabled runtimes pause for human approval first. **This matters here**: `send_campaign` emails your whole audience and cannot be recalled.

## Install

```bash
tutti-ai add sender
# or
npm install @tuttiai/sender
```

## Configuration

```
SENDER_API_KEY=...
```

Create a token under **Settings > API access tokens** in Sender. It is sent as `Authorization: Bearer <token>` to `https://api.sender.net/v2`. You can instead pass `api_key` in the voice options; the option wins over the environment variable. The token is never written to logs, errors or tool results.

## Tools (14)

| Tool | Destructive | Description |
|---|---|---|
| `list_groups` | no | List subscriber groups with ids and counts. |
| `list_subscribers` | no | List subscribers, optionally only one group's; paginate with `page`. |
| `get_subscriber` | no | One subscriber by email or id. |
| `list_campaigns` | no | List campaigns, filter by `DRAFT`, `SCHEDULED`, `SENDING` or `SENT`. |
| `get_campaign` | no | One campaign with status, schedule and delivery counts. |
| `create_subscriber` | no | Add a subscriber, optionally with groups and custom fields. |
| `update_subscriber` | no | Change name, groups, custom fields or email status. |
| `create_group` | no | Create an empty group. |
| `add_subscriber_to_group` | no | Add an existing subscriber to a group. |
| `remove_subscriber_from_group` | no | Remove a subscriber from a group (keeps the subscriber). |
| `create_campaign` | no | Create a **draft** HTML campaign. Never sends. |
| `send_campaign` | **yes** | Send a campaign now. Emails real people, irreversible. |
| `schedule_campaign` | **yes** | Schedule a campaign for later. Emails real people, irreversible once it fires. |
| `delete_subscriber` | **yes** | Permanently delete a subscriber. |

`create_subscriber`, `update_subscriber` and the group tools accept `trigger_automation: false` to avoid starting Sender automations, which can themselves send email.

## Errors

Tools never throw. A failure returns `is_error: true` with the HTTP status and Sender's own message, including field-level 422 validation errors and the `Retry-After` hint on a 429.

## Notes

- `schedule_campaign` takes `YYYY-MM-DD HH:MM:SS`. Sender's docs do not state the timezone.
- Sender's API accepts HTML or plain text only for campaign content; drag-and-drop templates must be built in the Sender app.
- `reply_to` must belong to a domain verified in your Sender account.

## License

Apache-2.0
