# @tuttiai/discord

Discord voice for [Tutti](https://tutti-ai.com) — gives agents a bot account they can use to read, post, and moderate messages.

Write tools (`post_message`, `edit_message`, `delete_message`, `add_reaction`, `send_dm`) are marked `destructive: true`, so HITL-enabled runtimes gate them behind human approval before anything hits a server.

## Install

```bash
tutti-ai add discord
# or
npm install @tuttiai/discord
```

## Bot setup

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Name it.
2. In the left sidebar go to **Bot** → **Reset Token** → copy the token into `DISCORD_BOT_TOKEN` in your `.env`. *The token is only shown once — save it now.*
3. Still on the **Bot** page, scroll to **Privileged Gateway Intents** and enable:
   - **Server Members Intent** — needed for `list_members`.
   - **Message Content Intent** — needed for `list_messages`, `get_message`, `search_messages`.
   *(Guilds + GuildMessages are enabled by default.)*
4. Go to **OAuth2** → **URL Generator**. Tick `bot` under **Scopes** and the permissions you want (minimum: **View Channels**, **Send Messages**, **Read Message History**, **Add Reactions**; add **Manage Messages** if you want `delete_message` to work on other users' messages).
5. Open the generated URL in a browser and invite the bot to your server.

## Environment

```
DISCORD_BOT_TOKEN=your_bot_token_here
```

That's the only env var. You can also pass `{ token }` directly to the constructor.

## Tools

| Tool | Destructive | Description |
|---|---|---|
| `post_message` | yes | Post to a channel. Optional `reply_to_message_id`. |
| `edit_message` | yes | Edit a message the bot wrote. |
| `delete_message` | yes | Delete a message (own, or any if the bot has Manage Messages). |
| `add_reaction` | yes | React with a unicode or custom emoji. |
| `send_dm` | yes | Direct-message a user by id. |
| `list_messages` | no | Recent messages in a channel, newest first, with `limit` / `before` / `after`. |
| `get_message` | no | Full detail on a single message. |
| `list_channels` | no | Text-capable channels in a guild with id, name, topic. |
| `list_members` | no | Guild members with roles + join timestamps. |
| `search_messages` | no | Local substring search over the last 100 messages in a channel. |
| `get_guild_info` | no | Name, member count, channel count, icon URL. |

## Example score

```ts
import { defineScore, AnthropicProvider } from "@tuttiai/core";
import { DiscordVoice } from "@tuttiai/discord";

export default defineScore({
  provider: new AnthropicProvider(),
  agents: {
    mod: {
      name: "mod",
      model: "claude-sonnet-4-6",
      system_prompt:
        "You are a community moderator. When users flag content, read the relevant messages, summarise, and propose (but do not execute) moderation actions unless explicitly approved.",
      voices: [new DiscordVoice()],
    },
  },
});
```

Run it:

```bash
tutti-ai run mod "Check #reports for new flags"
```

With a HITL-enabled runtime, any `post_message` / `delete_message` / `send_dm` call pauses for human approval before execution.

## Lifecycle

The voice's discord.js Client is lazily logged in on the first tool call and kept warm for the lifetime of the voice. Call `voice.teardown()` (or `TuttiRuntime.teardown()`) on shutdown to close the gateway connection cleanly.

## Links

- [Tutti](https://tutti-ai.com)
- [Voice source](https://github.com/tuttiai/tutti/tree/main/voices/discord)
- [Discord Developer Portal](https://discord.com/developers/applications)

## License

Apache 2.0
