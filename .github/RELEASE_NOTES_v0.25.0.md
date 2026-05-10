# v0.25.0 — All channels. All memories. All models.

Three release-shaping additions land together: a multi-platform inbound gateway, agent-curated memory paired with a per-user model, and OpenRouter access to 300+ models behind one API key.

## Inbox — every channel, one orchestrator

`@tuttiai/inbox` is a new inbound orchestrator. Telegram, Slack, Discord, Email and WhatsApp messages dispatch into a score-defined agent. Each platform stays in its voice (`@tuttiai/telegram`, `@tuttiai/slack`, `@tuttiai/discord`, `@tuttiai/email`, `@tuttiai/whatsapp`), and inbox dispatches through the voices' shared `forToken` / `forKey` client wrappers — so a single bot token only opens one platform connection, even when a score uses the voice for outbound tools AND the inbox adapter for inbound on the same key. Built in: allow-lists, per-user token-bucket rate limiting, per-chat serial queues with bounded depth, and typed `inbox:*` events that distinguish `not_allowlisted` / `rate_limited` / `queue_full` / `empty_text`.

```ts
inbox: {
  agent: "support",
  adapters: [
    { platform: "telegram" },
    { platform: "slack", appToken: "xapp-..." },
    { platform: "whatsapp" },
  ],
}
```

## Curated memory + user model — the agent decides what to remember

Agents can now call `remember`, `recall`, and `forget` themselves (alongside the existing system-prompt injection) when `agent.memory.semantic.curated_tools !== false`. Both surfaces share one `MemoryEnforcer` so per-agent caps, true-LRU eviction, and `memory:*` events fire exactly once per logical operation. Agent-written entries carry `source: "agent"` so consumers can distinguish them from system writes.

Layered on top: a new dialectic `UserProfile` per `user_id`. A `UserModelConsolidator` runs an LLM consolidation pass every N turns (default 20), reading recent entries from the agent's `UserMemoryStore` to produce a refreshed JSON profile (`summary`, `preferences`, `ongoing_projects`). Output validated against `UserProfileWritableSchema`; parse failures preserve the previous profile. Consolidation is fire-and-forget — failures are logged, never crash the run.

```
turn 4 — agent calls remember({ key: "preferred_language", value: "Italian" })
…
after 20 turns the UserProfile becomes:
{
  "summary": "Sara, freelance translator based in Milan…",
  "preferences": ["Italian responses", "concise replies", "morning emails"],
  "ongoing_projects": ["legal-translation contract for Banca XYZ"]
}
```

## OpenRouter — 300+ models, one API key

`OpenRouterProvider` exposes 300+ models across providers (Anthropic, OpenAI, Google, Meta, Mistral, …) through one API key by reusing the OpenAI SDK with a custom `baseURL` (default `https://openrouter.ai/api/v1`). Cost surfaces inline via OpenRouter's `usage: { include: true }` extension on `ChatResponse.usage.cost_usd` and `StreamChunk.usage.cost_usd` — no second `/generation` round trip. 401 → `AuthenticationError`, 429 → `RateLimitError` (with `Retry-After` parsing), other HTTP errors → `ProviderError`.

```ts
provider: { kind: "openrouter", model: "openai/gpt-5" }
```

## Migration

Fully additive. One field renamed: `AgentConfig.semantic_memory` → `AgentConfig.memory.semantic`.

## Acknowledgements

Hat tip to **Nous Research's Hermes Agent** for the inbound-gateway pattern and the self-curated-memory exposition. v0.25.0 leans on both ideas; the implementation, type discipline and operational guarantees here are Tutti-shaped, but the conceptual debt is owed.
