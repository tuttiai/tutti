# @tuttiai/inbox

Inbound messaging orchestrator for [Tutti](https://tutti-ai.com). Wires platform adapters (Telegram in v0.25.0; Slack/Discord/Twitter follow) to a score-defined agent and applies allow-list, rate-limit, queue-bound, and error-handling policy uniformly.

## Install

```bash
npm install @tuttiai/inbox
# Telegram adapter — install the voice as the runtime peer:
tutti-ai add telegram
```

The platform voices (`@tuttiai/telegram`, `@tuttiai/slack`, `@tuttiai/discord`, `@tuttiai/twitter`) are **optional peer dependencies** of `@tuttiai/inbox` — install only the ones you need. The matching adapter dynamically imports its voice and surfaces a friendly error when the peer is missing.

## Score example

```ts
import { TelegramVoice } from "@tuttiai/telegram";
import { defineScore } from "@tuttiai/core";

export default defineScore({
  agents: {
    support: {
      name: "support",
      system_prompt: "You are a Telegram support agent.",
      voices: [new TelegramVoice()],
      permissions: ["network"],
    },
  },
  inbox: {
    agent: "support",
    adapters: [{ platform: "telegram", polling: true }],
    allowedUsers: { telegram: ["123456789"] },
    rateLimit: { messagesPerWindow: 30, windowMs: 60_000, burst: 10 },
    maxQueuePerChat: 10,
  },
});
```

Then run:

```bash
TELEGRAM_BOT_TOKEN=… tutti-ai inbox start
```

## Why a separate package?

- **Avoids platform lock-in.** Adding a new platform is a new adapter, not a fork of the orchestrator.
- **Pay-for-what-you-use.** A Telegram-only deployment doesn't ship a Discord SDK.
- **Single bot connection.** Both the platform voice (outbound tools) and the inbox adapter (inbound messages) resolve to the same `*ClientWrapper.forToken(token)` cache, so e.g. a Discord bot opens exactly one Gateway session even when both surfaces are active — Discord rejects two simultaneous sessions per token, so this is a correctness requirement.

## Safety, by default

| Surface | Default | Why |
|---|---|---|
| Per-user rate limit | 30 msg / 60 s, burst 10 | Public bot endpoint = DoS surface. Don't burn the agent budget on a spammer. |
| Per-chat serial queue | depth 10 | A reply for message N must ship before message N+1 runs. Excess depth is dropped, not buffered indefinitely. |
| Allow-list | off (every sender accepted) | Off-by-default; explicit opt-in to harden. |
| `inbox:message_received` event | text length only | The message text is **not** in the event — subscribe to the adapter directly if you need it. |

Errors at any stage emit `inbox:error` (with a `SecretsManager`-redacted message) and call the optional `onError` callback. The inbox itself never crashes — adapters keep listening.

## Events

The orchestrator emits four typed events on `runtime.events`:

- `inbox:message_received` — passed allow-list + rate-limit + queue, about to dispatch.
- `inbox:message_replied` — agent run completed and reply handed to the adapter.
- `inbox:message_blocked` — dropped before dispatch. `reason` is `"not_allowlisted" | "rate_limited" | "queue_full" | "empty_text"`.
- `inbox:error` — caught error at any stage. The inbox keeps running.

## Identity & cross-platform sessions

`InMemoryIdentityStore` (default) is a union-find over `${platform}:${platform_user_id}` strings. After a user authenticates, you can call `identityStore.link("telegram:42", "slack:U7")` to make both sides resolve to the same session — the agent then sees one continuous conversation regardless of where the next message arrives.

## Adapters

| Platform | Module | Status |
|---|---|---|
| Telegram | `TelegramInboxAdapter` (this package) | Shipped in v0.25.0 |
| Slack | — | Follows in v0.25.1 against `voices/slack`'s shared client |
| Discord | — | Follows in v0.25.1 against `voices/discord`'s shared client |
| Twitter | — | Follows once a `voices/twitter` shared client lands |

## License

Apache-2.0.
