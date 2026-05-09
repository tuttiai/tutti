# @tuttiai/whatsapp

WhatsApp voice for [Tutti](https://tutti-ai.com) — gives agents the ability to send WhatsApp messages via Meta's official **Cloud API**, and powers the inbound webhook for [`@tuttiai/inbox`](https://github.com/tuttiai/tutti)'s WhatsApp adapter.

Two tools ship, both `destructive: true`:
- `send_text_message` — free-form text. Only valid within the 24h customer-service window.
- `send_template_message` — pre-approved Message Templates. Required for re-engagement outside the 24h window.

## Why Cloud API and not whatsapp-web.js?

This voice uses **Meta's official Cloud API** (Graph API v21+). It does NOT use `whatsapp-web.js` or any unofficial WhatsApp Web automation. Reasons:

- **ToS** — automating WhatsApp Web violates WhatsApp's terms; accounts can be banned.
- **Stability** — unofficial libraries break on every WhatsApp Web update; the Cloud API is contracted.
- **Auth** — the Cloud API uses System User access tokens; no QR codes, no phone-pairing.
- **Reliability** — webhooks are delivered with retries; web-automation pipelines silently drop on disconnect.

## Prerequisites

You'll need (each is documented at <https://developers.facebook.com/docs/whatsapp/cloud-api>):

1. **Meta Business Account** — <https://business.facebook.com>.
2. **Meta App** with the WhatsApp product enabled.
3. **A test or production phone number** — Meta provides one free test number per app.
4. **Permanent access token** — generated as a System User in Meta Business → System Users. Scopes: `whatsapp_business_messaging`, `whatsapp_business_management`. (Temporary 24h tokens work for local poking but expire.)
5. **Webhook verify token** — any random string you generate (`openssl rand -hex 32`). You configure both this voice AND the Meta App with the same value.
6. **App Secret** — Meta App → Settings → Basic → App Secret. Used to verify HMAC-SHA256 signatures on every inbound webhook.

## Required environment variables

| Var | Used for |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | System User access token (or temporary token for testing). |
| `WHATSAPP_VERIFY_TOKEN` | Random string. Must match the value configured in the Meta App webhook UI. |
| `WHATSAPP_APP_SECRET` | App Secret. Used to verify `X-Hub-Signature-256` on every inbound. |

The `phoneNumberId` is NOT a secret — it's an opaque identifier you find in the Meta App dashboard alongside the test phone number. It stays in the score.

## Score example

```ts
import { WhatsAppVoice } from "@tuttiai/whatsapp";
import { defineScore } from "@tuttiai/core";

export default defineScore({
  agents: {
    support: {
      name: "support",
      system_prompt: "You are a WhatsApp support agent.",
      voices: [new WhatsAppVoice({ phoneNumberId: "1234567890" })],
      permissions: ["network"],
    },
  },
});
```

## The webhook tunnel — main UX wart

The Cloud API requires Meta to POST inbound messages to a **public HTTPS endpoint**. The voice spins up a Fastify server on port 3848 (configurable) hosting `GET /webhook` (Meta's verify handshake) and `POST /webhook` (inbound messages). You need to expose that port to the internet:

```bash
# Cloudflare Tunnel — recommended for production
cloudflared tunnel --url http://localhost:3848

# ngrok — fine for dev
ngrok http 3848

# Or run a proper reverse proxy (nginx, Caddy) in front of port 3848
```

Then in **Meta App → WhatsApp → Configuration**:
- Callback URL: `https://<your-tunnel>/webhook`
- Verify token: the value you set in `WHATSAPP_VERIFY_TOKEN`
- Subscribe to the `messages` webhook field (delivery-status events are silently ignored by the voice).

Send a test WhatsApp message from your personal phone to the configured business number. It should arrive in your agent within seconds.

## The 24-hour customer-service window

WhatsApp's most surprising rule: outside of 24 hours since the user's last inbound message, you can only send **pre-approved Message Templates**, not free-form text. The Cloud API rejects free-form messages outside this window with error `131047`.

`send_text_message` surfaces 131047 with a clear hint pointing at `send_template_message`. Templates have to be registered + approved in Meta App → WhatsApp → Message Templates before they can be sent.

## Limitations in v0.25

- **Group chats** are not supported by the Cloud API for two-way bots — Meta does not deliver group messages over webhooks. Direct messages only.
- **Outbound media** is not in v0.25 — text only. (Inbound media is surfaced as `[image]` / `[audio]` etc. with the resolved URL on the message's `raw` object.)
- **Polling fallback** — there isn't one. Webhooks are mandatory; the tunnel requirement is real.

## Inbound (inbox)

The voice's `WhatsAppClientWrapper` exposes `subscribeMessage(handler)` so [`@tuttiai/inbox`](https://github.com/tuttiai/tutti)'s WhatsApp adapter consumes the same Fastify server (one webhook listener, regardless of whether the voice + adapter are both active). Sharing happens via `WhatsAppClientWrapper.forKey(phoneNumberId, …)` — keyed by the bot identity.

Defence-in-depth applied at the wrapper boundary:

| Surface | Default |
|---|---|
| HMAC-SHA256 signature check on every POST | Mandatory. Rejected (401) without the correct `X-Hub-Signature-256` header from Meta. |
| 200 ack BEFORE handler dispatch | Mandatory. Meta retries non-2xx within ~20s; blocking on agent work would cause duplicates. |
| Inbound text redaction (`SecretsManager.redact`) | On by default. Opt out via `redactRawText: false`. |
| Body size limit | 5 MB. Configurable via `bodyLimit`. |
| Constant-time signature comparison (`timingSafeEqual`) | Mandatory. Rejects length-mismatched and prefix-malformed signatures without throwing. |

## Lifecycle

The wrapper builds the Fastify instance immediately on construction (so tests can use `app.inject(...)` without binding to a port). The actual `listen()` call happens in `launch()` — called by the inbox adapter's `start()`. `destroy()` closes the Fastify server and clears subscribers.

## License

Apache-2.0.
