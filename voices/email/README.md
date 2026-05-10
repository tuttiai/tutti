# @tuttiai/email

Email voice for [Tutti](https://tutti-ai.com) — gives agents the ability to read inbound mail (IMAP IDLE) and send outbound mail with proper threading (SMTP). Also exports the shared `EmailClientWrapper` that [`@tuttiai/inbox`](https://github.com/tuttiai/tutti)'s email adapter consumes.

Three tools ship: `send_email` and `send_reply` are marked `destructive: true`; `list_inbox` is read-only.

## Install

```bash
tutti-ai add email
# or
npm install @tuttiai/email
```

## Setup

The voice needs IMAP and SMTP credentials. Host, port, user and TLS settings live in the score; **passwords come from env vars**:

| Var | Used for |
|---|---|
| `TUTTI_EMAIL_PASSWORD` | Shared fallback for both IMAP and SMTP. Use this when both are the same password (Gmail, IONOS, most providers). |
| `TUTTI_EMAIL_IMAP_PASSWORD` | IMAP-only override. |
| `TUTTI_EMAIL_SMTP_PASSWORD` | SMTP-only override. |

For Gmail / Outlook with 2FA, basic auth is disabled — generate an [app-specific password](https://support.google.com/accounts/answer/185833).

## Score example

```ts
import { EmailVoice } from "@tuttiai/email";
import { defineScore } from "@tuttiai/core";

export default defineScore({
  agents: {
    support: {
      name: "support",
      system_prompt: "You are an email support agent. Read incoming mail and send threaded replies.",
      voices: [
        new EmailVoice({
          imap: { host: "imap.example.com", port: 993, user: "bot@example.com" },
          smtp: { host: "smtp.example.com", port: 587, user: "bot@example.com" },
          from: "Tutti Bot <bot@example.com>",
        }),
      ],
      permissions: ["network"],
    },
  },
});
```

## Tools

| Tool | Description |
|---|---|
| `send_email` | Send a fresh email. Single string or array of recipients; cc / bcc supported. |
| `send_reply` | Reply with proper `In-Reply-To` and `References` headers. The `in_reply_to` Message-ID comes from `list_inbox` (or from the inbox event payload). |
| `list_inbox` | List recent messages (Message-ID, from, subject, date). Defaults to UNSEEN, capped at 50 entries. |

## Inbound (inbox)

The wrapper exposes `subscribeMessage(handler)` powered by IMAP IDLE — no polling, the server pushes new mail. [`@tuttiai/inbox`](https://github.com/tuttiai/tutti)'s `EmailInboxAdapter` consumes this. A score that wires both the voice (outbound tools) and the inbox adapter (inbound) shares one `EmailClientWrapper` via `EmailClientWrapper.forKey("host:port:user", …)` — one IMAP connection, one SMTP transporter.

The wrapper drops messages oversized via the IMAP `SIZE` flag before parsing (default 1 MB plain text, configurable via `maxBodyChars`), and runs `SecretsManager.redact` on the dispatched body by default to keep accidental leaked credentials out of agent traces. Set `redactRawText: false` to opt out.

## Lifecycle

The IMAP connection is established lazily on the first `subscribeMessage` / `list_inbox` / explicit `launch()` call, and stays open with IDLE-driven push. SMTP transports are pooled by nodemailer and created on first send. Call `voice.teardown()` (or `TuttiRuntime.teardown()`) on shutdown — both connections are closed cleanly.

## License

Apache-2.0.
