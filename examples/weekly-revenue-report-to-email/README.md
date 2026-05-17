# Weekly revenue report to email

A single scheduled agent that, every Monday at 08:00, pulls last week's
revenue from Stripe and active subscription state from Postgres, writes
a one-page report, and emails it to the founders. Cron triggers the run;
the scheduler delivers via `@tuttiai/email` SMTP — no email tool is
invoked by the agent itself.

## Setup

1. Install voices (already in the monorepo):

   ```bash
   npm install
   npm run build
   ```

2. Stripe — a restricted key with read scope on Charges, Invoices,
   Refunds, Subscriptions, Balance, and Balance Transactions is enough:

   ```bash
   export STRIPE_SECRET_KEY=rk_live_...
   ```

3. Postgres — point at your read-replica if you have one. The example
   uses the default connection variables resolved by `@tuttiai/postgres`:

   ```bash
   export DATABASE_URL=postgres://reporter:...@db.example.com:5432/app
   ```

4. Email — IMAP is required by `EmailVoice` even when you only need
   outbound; both directions share one credential set:

   ```bash
   export TUTTI_EMAIL_PASSWORD=...    # or split into
   #   TUTTI_EMAIL_IMAP_PASSWORD / TUTTI_EMAIL_SMTP_PASSWORD
   ```

   Edit `tutti.score.ts` to set your real IMAP/SMTP hosts, ports, the
   `from` address, and the founders' `to` address.

5. Anthropic provider:

   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   ```

## Run

Sanity check the score loads:

```bash
npx tsx examples/weekly-revenue-report-to-email/tutti.score.ts --check
```

Boot the scheduler:

```bash
tutti-ai run --score examples/weekly-revenue-report-to-email/tutti.score.ts
```

The first cron fire-time after process start is when the first email
lands.

## Subject line

The `subject` field is fixed in this example. To get a date in the
subject, omit `subject` from the `deliver` block — the scheduler
substitutes `<agent name> — <ISO date>` automatically.
