# @tuttiai/stripe

Stripe voice for [Tutti](https://tutti-ai.com) — broad coverage of the Stripe API: customers, products, prices, payment links, payment intents, charges, refunds, subscriptions, invoices, disputes, and balance.

Every write tool is marked `destructive: true`, so HITL-enabled runtimes pause for human approval before any state change. **This matters here**: a `create_refund`, `cancel_subscription`, or `void_invoice` against a `sk_live_` key moves real money.

## Install

```bash
tutti-ai add stripe
# or
npm install @tuttiai/stripe
```

## Configuration

```
STRIPE_SECRET_KEY=sk_test_...   # use test mode while developing!
```

Get your key from <https://dashboard.stripe.com/apikeys>. **Strongly prefer `sk_test_` keys until you trust the agent.** The voice detects the `sk_live_` prefix and stamps `[test]` on every output line for test-mode keys; you should rely on that visual cue while reviewing.

For least-privilege production deployments, create a [restricted key](https://stripe.com/docs/keys#create-restricted-api-secret-key) granting only the resources the agent needs (e.g. read on customers/charges/invoices, write on refunds).

## Tools (27)

### Customers (3)

| Tool | Destructive | Description |
|---|---|---|
| `list_customers` | no | List customers, filter by email, paginate. |
| `get_customer` | no | One customer by id. |
| `create_customer` | yes | Create a new customer. |

### Products + Prices (4)

| Tool | Destructive | Description |
|---|---|---|
| `list_products` | no | List products, filter by active flag. |
| `create_product` | yes | New product. |
| `list_prices` | no | List prices, filter by product/active. |
| `create_price` | yes | New price (one-time or recurring) for a product. |

### Payment Links (1)

| Tool | Destructive | Description |
|---|---|---|
| `create_payment_link` | yes | Shareable checkout link for one or more prices. |

### Payments (5)

| Tool | Destructive | Description |
|---|---|---|
| `list_payment_intents` | no | List intents, filter by customer. |
| `get_payment_intent` | no | One intent with status, amounts, last error. |
| `cancel_payment_intent` | yes | Cancel an uncaptured intent. |
| `list_charges` | no | List charges, filter by customer/payment_intent. |
| `get_charge` | no | One charge with capture/refund details. |

### Refunds (3)

| Tool | Destructive | Description |
|---|---|---|
| `list_refunds` | no | List refunds, filter by charge/payment_intent. |
| `get_refund` | no | One refund. |
| `create_refund` | yes | **Refund a charge or intent — moves money back to the customer.** |

### Subscriptions (3)

| Tool | Destructive | Description |
|---|---|---|
| `list_subscriptions` | no | List subs, filter by customer/status. |
| `get_subscription` | no | One sub with period + line items. |
| `cancel_subscription` | yes | Immediate cancel (with optional `invoice_now` / `prorate`). |

### Invoices (4)

| Tool | Destructive | Description |
|---|---|---|
| `list_invoices` | no | List invoices, filter by customer/status. |
| `get_invoice` | no | One invoice with totals + hosted URL + PDF. |
| `finalize_invoice` | yes | Move draft → open and (per collection settings) attempt payment. |
| `void_invoice` | yes | Void an open invoice — permanent. |

### Disputes (2)

| Tool | Destructive | Description |
|---|---|---|
| `list_disputes` | no | List disputes, filter by charge/payment_intent. |
| `get_dispute` | no | One dispute with status + reason. |

### Balance (2)

| Tool | Destructive | Description |
|---|---|---|
| `get_balance` | no | Available + pending funds, by currency. |
| `list_balance_transactions` | no | Per-entry money movement (charges, refunds, payouts, fees). |

## Example score

```ts
import { defineScore, AnthropicProvider } from "@tuttiai/core";
import { StripeVoice } from "@tuttiai/stripe";

export default defineScore({
  provider: new AnthropicProvider(),
  agents: {
    support: {
      name: "support",
      model: "claude-sonnet-4-6",
      system_prompt:
        "You handle Stripe support tickets. Look up customers and charges, surface the relevant details, and propose refunds — but DO NOT issue refunds without explicit operator approval.",
      voices: [new StripeVoice()],
      permissions: ["network"],
    },
  },
});
```

```bash
tutti-ai run support "Find the most recent charge for chihab@example.com and explain what it was for"
```

With a HITL-enabled runtime, every destructive call (`create_refund`, `cancel_subscription`, `void_invoice`, etc.) pauses for approval before reaching Stripe.

## Notes & gotchas

- **Amounts are in the smallest currency unit.** `999` USD is $9.99. JPY/KRW/etc. (zero-decimal currencies) pass the major unit directly. The voice formats output through `Intl.NumberFormat`, so what the agent reads is human-friendly even if what it sends is integers.
- **Pinned API version**: `2025-08-27.basil`. Pinning protects formatted output from silent dashboard-side version bumps. Override via the SDK constructor if you need a different pin.
- **Refunds are real**. `create_refund` on a `sk_live_` key moves money; full refunds are immediate. Always test with `sk_test_` first and rely on HITL approval in production.
- **Cancellation timing**: `cancel_payment_intent` only works on uncaptured intents. After capture, use `create_refund`. `cancel_subscription` is immediate; for "cancel at period end" use the SDK directly with `update_subscription` (not yet exposed by this voice).
- **Pagination is cursor-based**. List tools return `(more available; pass starting_after=<id>)` when there's a next page.
- **Restricted keys are recommended**. The voice does not enforce least privilege — Stripe does, when you scope the API key.

## Lifecycle

The Stripe SDK is created lazily on the first tool call. Stripe is stateless HTTP, so `voice.teardown()` clears the cached client; calling it on shutdown is safe but not strictly required.

## Links

- [Tutti](https://tutti-ai.com)
- [Voice source](https://github.com/tuttiai/tutti/tree/main/voices/stripe)
- [Stripe API reference](https://stripe.com/docs/api)
- [Stripe restricted keys](https://stripe.com/docs/keys#create-restricted-api-secret-key)

## License

Apache 2.0
