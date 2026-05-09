# @tuttiai/telegram

Telegram voice for [Tutti](https://tutti-ai.com) — gives agents a bot token they can use to read, post and moderate messages on Telegram.

The voice ships four outbound tools (`post_message`, `edit_message`, `delete_message`, `send_photo`) all marked `destructive: true`, so HITL-enabled runtimes gate them behind human approval before anything is sent.

The same package also exports `TelegramClientWrapper` — a token-keyed, reference-counted bot wrapper that `@tuttiai/inbox` reuses for its inbound Telegram adapter. Telegram's `getUpdates` polling does not allow two simultaneous sessions per bot token, so sharing the underlying bot is mandatory for the voice + inbox combination.

## Install

```bash
tutti-ai add telegram
# or
npm install @tuttiai/telegram
```

## Bot setup

1. Open [@BotFather](https://t.me/BotFather) in Telegram and send `/newbot`. Pick a display name and a username; it must end in `bot` (e.g. `my_tutti_bot`). BotFather replies with the bot token.
2. Set the env var:
   ```
   TELEGRAM_BOT_TOKEN=123456789:AA…your-token…
   ```
3. (Inbox use only.) If the bot needs to read non-mention messages in groups, send `/setprivacy` to BotFather, choose your bot, and select **Disable**.
4. Add the bot to a chat or channel you want it to post in. For channels, the bot must be made an administrator with **Post messages** rights.

## Score example

```ts
import { TelegramVoice } from "@tuttiai/telegram";
import { defineScore } from "@tuttiai/core";

export default defineScore({
  agents: {
    support: {
      name: "support",
      system_prompt: "You are a Telegram support agent. Use the telegram voice to reply.",
      voices: [new TelegramVoice()],
      permissions: ["network"],
    },
  },
  // ...
});
```

## Tools

| Tool | Description |
|---|---|
| `post_message` | Send a text message to a chat or channel. Up to 4096 chars. |
| `edit_message` | Edit a message the bot previously sent (< 48h old). |
| `delete_message` | Delete a message. The bot can always delete its own; deleting others requires admin rights. |
| `send_photo` | Send a photo by URL or `file_id`. Optional caption (1024 chars). |

All four tools accept either a numeric `chat_id` (e.g. `12345`, `-1001234567890` for supergroups) or a `@channel_username` string.

## Lifecycle

The bot is created lazily on the first tool call. For outbound-only use, no polling loop is started — the Telegram REST API works without one. When `@tuttiai/inbox` adds a Telegram adapter against the same token, the wrapper installs a single shared `getUpdates` poll that fan-outs to both the voice and the inbox handler.

Call `voice.teardown()` (or `TuttiRuntime.teardown()`) on shutdown to release the wrapper's reference. The bot is only stopped when the last holder releases.
