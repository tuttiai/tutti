/**
 * Marketing agent example — an illustration of what you can build with
 * Tutti. Fork this directory, fill in brand/*.md with your own content,
 * set the env vars, and run.
 *
 * Shape:
 *   - marketing (orchestrator) delegates to three specialists
 *   - twitter — owns your X/Twitter account (writes are HITL-gated)
 *   - discord — owns your community Discord (writes are HITL-gated)
 *   - content — researches the web and drafts copy grounded in brand/*.md
 *   - support (NEW in v0.25.0) — handles inbound messages across
 *     Telegram, Slack, Discord, email and WhatsApp via @tuttiai/inbox.
 *     The marketing agent now reaches users on every channel.
 *
 * Every destructive tool (post, delete, DM, edit, react) is marked
 * `destructive: true` upstream, so Tutti pauses for operator approval
 * before anything goes live.
 *
 * Run the marketing orchestrator interactively:
 *   tutti-ai run --score examples/marketing-agent/tutti.score.ts
 *
 * Boot the inbound listener (5 platforms, see `inbox` block below):
 *   tutti-ai inbox start examples/marketing-agent/tutti.score.ts
 *
 * Sanity check without running an agent:
 *   npx tsx examples/marketing-agent/tutti.score.ts --check
 */

import {
  AnthropicProvider,
  SecretsManager,
  defineScore,
  piiDetector,
  profanityFilter,
} from "@tuttiai/core";
import { RagVoice } from "@tuttiai/rag";
import { TwitterVoice } from "@tuttiai/twitter";
import { DiscordVoice } from "@tuttiai/discord";
import { WebVoice } from "@tuttiai/web";
import { TelegramVoice } from "@tuttiai/telegram";
import { SlackVoice } from "@tuttiai/slack";
import { EmailVoice } from "@tuttiai/email";
import { WhatsAppVoice } from "@tuttiai/whatsapp";

// ---------------------------------------------------------------------------
// Brand knowledge — the content agent grounds every claim in these docs.
// ---------------------------------------------------------------------------

const BRAND_COLLECTION = "brand";

// RAG embeddings. OpenAI is the default because most devs already have
// an OPENAI_API_KEY. Swap to Voyage (provider: "anthropic") or a local
// Ollama endpoint if that's not true for you.
//
// The "unset-placeholder" fallback lets `tsx tutti.score.ts --check`
// succeed without real credentials so CI can assert the score wires up
// correctly. Actual runs still fail fast at the first embed call with
// the provider's authentication error — which is the right error to see.
const ragVoice = RagVoice({
  collection: BRAND_COLLECTION,
  embeddings: {
    provider: "openai",
    api_key:
      SecretsManager.optional("OPENAI_API_KEY") ?? "sk-unset-placeholder",
  },
  storage: { provider: "memory" },
});

// ---------------------------------------------------------------------------
// Inbox connection details (host/port/identifiers only — secrets via env)
// ---------------------------------------------------------------------------

const EMAIL_CONN = {
  imap: { host: "imap.example.com", port: 993, user: "bot@example.com" },
  smtp: { host: "smtp.example.com", port: 587, user: "bot@example.com" },
  from: "Tutti Bot <bot@example.com>",
} as const;

const WHATSAPP_PHONE_NUMBER_ID = "1234567890";

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

const score = defineScore({
  provider: new AnthropicProvider(),
  entry: "marketing",

  agents: {
    marketing: {
      name: "Marketing Orchestrator",
      role: "orchestrator",
      model: "claude-sonnet-4-6",
      voices: [],
      delegates: ["twitter", "discord", "content"],
      budget: { max_cost_usd: 0.5 },
      system_prompt: `You are the marketing orchestrator for the brand
described in brand/*.md.

You delegate to three specialists:
  - twitter — for anything on X/Twitter.
  - discord — for anything in the community Discord.
  - content — for researching the web and drafting copy grounded in
    brand/*.md.

Never post without first drafting with content and having twitter or
discord confirm with the user. HITL is on for every destructive tool
across all three specialists — you do not need to add manual approval
instructions.

House rules:
  - Draft first, then post. Every write tool call is gated by HITL; do
    not spam the approval queue by calling write tools speculatively.
  - Ground every claim in brand/talking-points.md and
    brand/positioning.md.
  - Keep outputs concise. Tweets under 240 characters. Discord
    messages under 400.`,
    },

    twitter: {
      name: "Twitter Agent",
      role: "specialist",
      model: "claude-sonnet-4-6",
      permissions: ["network"],
      voices: [new TwitterVoice()],
      requireApproval: ["post_tweet", "post_thread", "delete_tweet"],
      afterRun: profanityFilter(),
      system_prompt: `You manage the brand's X/Twitter account.

Before posting, always delegate to the content agent to draft the
copy against brand-voice.md and talking-points.md.

Follow the tone rules in brand-voice.md exactly. Use threads for
longer content and single tweets for short announcements.

You have these tools:
  - post_tweet / post_thread / delete_tweet — destructive, HITL-gated.
  - search_tweets / get_tweet / list_mentions / list_replies /
    get_user / get_timeline — read-only.

When the user asks for engagement work, read mentions first, then
draft replies with content, then post each one (each will prompt for
approval).`,
    },

    discord: {
      name: "Discord Agent",
      role: "specialist",
      model: "claude-sonnet-4-6",
      permissions: ["network"],
      voices: [new DiscordVoice()],
      requireApproval: ["post_message", "send_dm", "delete_message"],
      beforeRun: piiDetector("block"),
      system_prompt: `You manage the community Discord for the brand
described in brand/*.md.

Responsibilities:
  - Welcome new members with a short, warm message.
  - Answer questions by delegating to content for the research, then
    posting the answer (approval-gated).
  - Triage issues: read the report, ask clarifying questions in-thread,
    and if reproducible acknowledge with a short reply.
  - Never post without HITL approval.

Tools:
  - post_message / edit_message / delete_message / add_reaction /
    send_dm — destructive, HITL-gated.
  - list_messages / get_message / list_channels / list_members /
    search_messages / get_guild_info — read-only.

Don't DM users except for onboarding follow-ups; in-channel replies
are the default.`,
    },

    support: {
      name: "Support Agent",
      role: "specialist",
      model: "claude-sonnet-4-6",
      permissions: ["network"],
      voices: [
        new TelegramVoice(),
        new SlackVoice(),
        new DiscordVoice(),
        new EmailVoice(EMAIL_CONN),
        new WhatsAppVoice({ phoneNumberId: WHATSAPP_PHONE_NUMBER_ID }),
      ],
      budget: { max_cost_usd: 0.05 },
      beforeRun: piiDetector("redact"),
      system_prompt: `You handle inbound user messages from any of five
channels: Telegram, Slack, Discord, email, and WhatsApp. The
@tuttiai/inbox orchestrator dispatches each inbound message to you;
you reply on the same channel automatically — the inbox adapter
threads correctly (Re: subject + In-Reply-To on email; same chat on
the others).

Tone:
  - Friendly and short. Aim for under 80 words on chat platforms,
    under 200 on email.
  - First-line acknowledgement, then answer or next step.
  - For complex questions, defer to the marketing orchestrator by
    saying "I'll get back to you" and noting the channel + sender.

Constraints:
  - WhatsApp free-form replies only work within 24h of the user's
    last inbound. If you need to re-engage outside that window you'd
    need a pre-approved template — for v0.25 we don't ship a default,
    so just say "We'll follow up by email" instead.
  - Email subject already arrives as "Subject: …" prepended to the
    body — read it as conversation context, don't echo it back.
  - You don't have access to brand/*.md directly; if a user asks
    something brand-specific, say "Let me get the full answer for
    you" and stop — operators triage from the trace.`,
    },

    content: {
      name: "Content Agent",
      role: "specialist",
      model: "claude-sonnet-4-6",
      permissions: ["network"],
      voices: [ragVoice, new WebVoice()],
      system_prompt: `You produce brand-consistent copy.

Step 1 — bootstrap.
The RAG knowledge base (collection "${BRAND_COLLECTION}") starts empty
on every fresh process. If your first search_knowledge call returns
nothing, ingest every file in brand/ via the ingest_document tool
before doing anything else. Use the filename as the source_id. After
that, search the knowledge base — do not re-ingest.

Step 2 — ground.
Before drafting any copy, search_knowledge for relevant chunks:
  - For tone / voice questions: brand-voice.md
  - For positioning / audience: positioning.md
  - For capability claims: talking-points.md
  - For the tagline and its usage rules: tagline.md

Step 3 — research (optional).
Use the web voice (web_search / web_fetch) for fresh facts. Wrap
external quotes in clear attribution.

Step 4 — draft.
Produce the copy. Include the sources you grounded each claim in —
the twitter and discord agents need to see your reasoning to decide
whether to post.

Do not invent product features, versions, or metrics. If the brand
docs don't mention something, say so and ask the orchestrator for
approval before inventing it.`,
    },
  },

  // ── Inbound (NEW in v0.25.0) — five platforms, one agent ──────────
  // `tutti-ai inbox start` boots the orchestrator and connects every
  // adapter declared here. Each inbound message is dispatched to
  // `support`. Tokens / passwords resolve from env via SecretsManager
  // (TELEGRAM_BOT_TOKEN, SLACK_BOT_TOKEN + SLACK_APP_TOKEN,
  // DISCORD_BOT_TOKEN, TUTTI_EMAIL_PASSWORD or its IMAP/SMTP variants,
  // and WHATSAPP_ACCESS_TOKEN + WHATSAPP_VERIFY_TOKEN +
  // WHATSAPP_APP_SECRET). The score never carries them.
  //
  // WhatsApp note: the Cloud API requires a public webhook endpoint.
  // Run a tunnel before starting the inbox, e.g.
  //   cloudflared tunnel --url http://localhost:3848
  // and configure the Meta App's Callback URL accordingly.
  inbox: {
    agent: "support",
    adapters: [
      { platform: "telegram" },
      { platform: "slack" },
      { platform: "discord" },
      { platform: "email", ...EMAIL_CONN },
      { platform: "whatsapp", phoneNumberId: WHATSAPP_PHONE_NUMBER_ID },
    ],
    rateLimit: { messagesPerWindow: 60, windowMs: 60_000, burst: 20 },
    maxQueuePerChat: 10,
  },
});

export default score;

// ---------------------------------------------------------------------------
// Quick sanity check — `npx tsx tutti.score.ts --check`
//
// Prints every agent with its role, voices, destructive tool list, and
// requireApproval config. Use it to confirm the score loads before
// wiring it into a runtime.
// ---------------------------------------------------------------------------

if (process.argv.includes("--check")) {
  const summary = {
    entry: score.entry,
    agents: Object.entries(score.agents).map(([id, a]) => ({
      id,
      name: a.name,
      role: a.role,
      model: a.model,
      delegates: a.delegates,
      voices: a.voices.map((v) => v.name),
      destructive_tools: a.voices.flatMap((v) =>
        v.tools.filter((t) => t.destructive === true).map((t) => t.name),
      ),
      requireApproval: a.requireApproval,
    })),
    inbox: score.inbox
      ? {
          agent: score.inbox.agent,
          adapters: score.inbox.adapters.map((a) => a.platform),
          rateLimit: score.inbox.rateLimit,
        }
      : undefined,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  process.exit(0);
}
