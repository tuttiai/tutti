/**
 * Weekly revenue report → email — scheduled cron + email delivery.
 *
 * A single agent ("revenue-reporter") wakes up Monday at 08:00, pulls
 * last week's revenue from Stripe and active subscription state from
 * Postgres, writes a one-page report, and the scheduler emails it to
 * the founders via the `@tuttiai/email` voice's SMTP transporter.
 *
 * Quick check (no run):
 *   npx tsx examples/weekly-revenue-report-to-email/tutti.score.ts --check
 *
 * Boot the scheduler:
 *   tutti-ai run --score examples/weekly-revenue-report-to-email/tutti.score.ts
 */

import { AnthropicProvider, defineScore } from "@tuttiai/core";
import { StripeVoice } from "@tuttiai/stripe";
import { PostgresVoice } from "@tuttiai/postgres";
import { EmailVoice } from "@tuttiai/email";

// IMAP is required by EmailVoice (the same wrapper handles inbox-read
// via IDLE) but the scheduler only needs SMTP. Wire IMAP to the same
// host so credentials resolve from one TUTTI_EMAIL_PASSWORD env var.
const EMAIL_CONN = {
  imap: { host: "imap.example.com", port: 993, user: "reports@company.com" },
  smtp: { host: "smtp.example.com", port: 587, user: "reports@company.com" },
  from: "Tutti Revenue <reports@company.com>",
} as const;

const score = defineScore({
  provider: new AnthropicProvider(),
  entry: "revenue-reporter",

  agents: {
    "revenue-reporter": {
      name: "Revenue Reporter",
      role: "specialist",
      model: "claude-sonnet-4-6",
      permissions: ["network"],
      voices: [
        new StripeVoice(),
        new PostgresVoice(),
        new EmailVoice(EMAIL_CONN),
      ],
      budget: { max_cost_usd: 0.5 },
      schedule: {
        cron: "0 8 * * 1",
        input:
          "Pull last week's revenue from Stripe and active subs from Postgres. " +
          "Write a one-page report.",
        deliver: {
          platform: "email",
          to: "founders@company.com",
          // Scheduler substitutes the agent name + ISO date when subject
          // is omitted. Hard-coded here for a recognisable inbox thread.
          subject: "Weekly revenue report",
        },
      },
      system_prompt: `You are the company's weekly revenue reporter.

On each scheduled run you produce a one-page report comparing last week
(the Monday-Sunday window that just ended) against the prior week.

Data sources:
  - Stripe (read-only tools): list_charges, list_invoices, list_refunds,
    list_subscriptions, get_balance, list_balance_transactions. Use
    'created' filters to scope to last week. Currency is whatever the
    account is configured in — quote it explicitly.
  - Postgres (read-only by default): query the application database for
    counts of active subscriptions, new signups, and churn. Schemas
    vary; start with list_schemas + list_tables to discover relevant
    tables, then query.

Sections, in order:
  1. Headline: gross revenue, net revenue (after refunds), MRR delta.
  2. Stripe breakdown: top 5 customers by spend, refund total, dispute
     count if non-zero.
  3. Subscriptions: active count, new this week, cancelled this week,
     net change.
  4. Risk flags: any unusual movement (>3σ from the prior 8-week mean,
     if you have the data; otherwise call out outliers qualitatively).

Constraints:
  - Plain prose with short headings. No markdown tables — many email
    clients render them badly.
  - Round currency to the nearest whole unit. Show percentages to one
    decimal.
  - Do NOT call the destructive 'execute' Postgres tool. Reads only.
  - Do NOT send the email yourself. Return the report text as your
    final reply; the scheduler delivers it to the founders.`,
    },
  },
});

export default score;

// ---------------------------------------------------------------------------
// Quick sanity check — `npx tsx tutti.score.ts --check`
// ---------------------------------------------------------------------------

if (process.argv.includes("--check")) {
  const summary = {
    entry: score.entry,
    agents: Object.entries(score.agents).map(([id, a]) => ({
      id,
      name: a.name,
      voices: a.voices.map((v) => v.name),
      schedule: a.schedule,
    })),
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  process.exit(0);
}
