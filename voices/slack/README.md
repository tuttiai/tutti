# @tuttiai/slack

Slack voice for [Tutti](https://tutti-ai.com) — gives agents a bot token they can use to read, post, and moderate messages in a workspace.

Write tools (`post_message`, `update_message`, `delete_message`, `add_reaction`, `send_dm`) are marked `destructive: true`, so HITL-enabled runtimes gate them behind human approval before anything hits the workspace.

## Install

```bash
tutti-ai add slack
# or
npm install @tuttiai/slack
```

## App setup

1. Create a Slack app at <https://api.slack.com/apps> → **Create New App** → **From scratch**. Pick your target workspace.
2. Open **OAuth & Permissions** in the sidebar. Under **Scopes → Bot Token Scopes** add the scopes you want. Recommended minimum:
   - `chat:write` — post messages
   - `channels:read` + `channels:history` — list and read public channels
   - `groups:read` + `groups:history` — same for private channels (optional)
   - `reactions:write` — add emoji reactions
   - `users:read` — list workspace members
   - `team:read` — read workspace metadata
   - `im:write` — open DM channels (needed by `send_dm`)
3. Click **Install to Workspace** and approve the permission prompt.
4. Copy the **Bot User OAuth Token** (starts with `xoxb-`) into `SLACK_BOT_TOKEN` in your `.env`.
5. Invite the bot to each channel you want it to read or post in: `/invite @your-bot` from inside the channel.

## Environment

```
SLACK_BOT_TOKEN=xoxb-your-bot-token-here
```

That's the only env var. You can also pass `{ token }` directly to the constructor.

## Tools

| Tool | Destructive | Description |
|---|---|---|
| `post_message` | yes | Post to a channel. Optional `thread_ts` to reply in a thread. |
| `update_message` | yes | Edit a message the bot wrote (Slack only allows bots to edit their own). |
| `delete_message` | yes | Delete a message the bot posted. |
| `add_reaction` | yes | React with an emoji name (with or without surrounding `:`). |
| `send_dm` | yes | Open a DM with a user and send a message in one step. |
| `list_messages` | no | Recent messages in a channel, newest first, with `limit` / `oldest` / `latest`. |
| `get_message` | no | Full detail on a single message by `channel + ts`. |
| `list_channels` | no | Public (and optionally private) channels with id, name, topic. |
| `list_members` | no | Workspace members with handle, real name, bot/deleted flags. |
| `search_messages` | no | Local substring search over the last 200 messages in a channel. |
| `get_workspace_info` | no | Workspace name, domain, icon URL. |

## Example score

```ts
import { defineScore, AnthropicProvider } from "@tuttiai/core";
import { SlackVoice } from "@tuttiai/slack";

export default defineScore({
  provider: new AnthropicProvider(),
  agents: {
    triage: {
      name: "triage",
      model: "claude-sonnet-4-6",
      system_prompt:
        "You triage incoming messages in #support. Read the channel, classify each message, and propose (but do not execute) a response unless explicitly approved.",
      voices: [new SlackVoice()],
    },
  },
});
```

Run it:

```bash
tutti-ai run triage "Catch me up on #support since yesterday"
```

With a HITL-enabled runtime, any `post_message` / `delete_message` / `send_dm` call pauses for human approval before execution.

## Notes & gotchas

- **Channel naming**: prefer channel IDs (`C0123ABCD`) over `#name` strings. Slack accepts both, but IDs survive renames and never collide.
- **Search scope**: workspace-wide search (`search.messages`) needs a user token (`xoxp-`), which standard bot installs do not have. `search_messages` does a local substring scan over the last 200 messages of one channel — same approach as the discord voice.
- **Bot must be a member**: read tools fail with `not_in_channel` until the bot is invited to a channel. Run `/invite @your-bot` once per channel.
- **Edit/delete restrictions**: bot tokens can only edit/delete messages the bot itself posted. To moderate other users' messages you need a user token with `chat:write` + the appropriate workspace permissions.

## Lifecycle

The Slack `WebClient` is stateless HTTP, so the voice keeps no long-lived connection. `voice.teardown()` clears the cached client; calling it on shutdown is safe but not strictly required.

## Links

- [Tutti](https://tutti-ai.com)
- [Voice source](https://github.com/tuttiai/tutti/tree/main/voices/slack)
- [Slack API docs](https://api.slack.com/web)

## License

Apache 2.0
