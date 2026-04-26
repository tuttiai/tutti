import Stripe from "stripe";
import { SecretsManager } from "@tuttiai/core";

// ---------------------------------------------------------------------------
// Resource shapes — narrow projections of stripe.* objects covering the
// fields our tools actually format. The real SDK types are gigantic; the
// narrow shapes here are what tests need to construct.
// ---------------------------------------------------------------------------

export interface StripeListResponse<T> {
  data: T[];
  has_more: boolean;
  url?: string;
}

export interface StripeCustomerLike {
  id: string;
  email?: string | null;
  name?: string | null;
  description?: string | null;
  phone?: string | null;
  currency?: string | null;
  created: number;
  livemode: boolean;
  delinquent?: boolean | null;
  deleted?: boolean;
  metadata?: Record<string, string> | null;
}

export interface StripeProductLike {
  id: string;
  name: string;
  description?: string | null;
  active: boolean;
  created: number;
  livemode: boolean;
  default_price?: string | null;
  metadata?: Record<string, string> | null;
}

export interface StripePriceLike {
  id: string;
  product: string;
  active: boolean;
  currency: string;
  unit_amount?: number | null;
  type: string;
  recurring?: { interval: string; interval_count: number } | null;
  nickname?: string | null;
  created: number;
  livemode: boolean;
}

export interface StripePaymentLinkLike {
  id: string;
  active: boolean;
  url: string;
  livemode: boolean;
  metadata?: Record<string, string> | null;
}

export interface StripePaymentIntentLike {
  id: string;
  amount: number;
  amount_received?: number;
  currency: string;
  status: string;
  customer?: string | null;
  description?: string | null;
  receipt_email?: string | null;
  created: number;
  livemode: boolean;
  cancellation_reason?: string | null;
  last_payment_error?: { code?: string | null; message?: string | null } | null;
}

export interface StripeChargeLike {
  id: string;
  amount: number;
  amount_captured: number;
  amount_refunded: number;
  currency: string;
  customer?: string | null;
  description?: string | null;
  status: string;
  paid: boolean;
  refunded: boolean;
  created: number;
  receipt_url?: string | null;
  failure_code?: string | null;
  failure_message?: string | null;
  payment_intent?: string | null;
  livemode: boolean;
}

export interface StripeRefundLike {
  id: string;
  amount: number;
  currency: string;
  charge?: string | null;
  payment_intent?: string | null;
  status?: string | null;
  reason?: string | null;
  created: number;
  livemode: boolean;
}

export interface StripeSubscriptionLike {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  current_period_start?: number;
  current_period_end?: number;
  created: number;
  canceled_at?: number | null;
  livemode: boolean;
  items?: { data: Array<{ id: string; price: { id: string }; quantity?: number }> };
  metadata?: Record<string, string> | null;
}

export interface StripeInvoiceLike {
  id: string;
  customer?: string | null;
  status?: string | null;
  total: number;
  amount_due: number;
  amount_paid: number;
  amount_remaining: number;
  currency: string;
  number?: string | null;
  hosted_invoice_url?: string | null;
  invoice_pdf?: string | null;
  created: number;
  livemode: boolean;
  paid?: boolean;
  due_date?: number | null;
}

export interface StripeDisputeLike {
  id: string;
  amount: number;
  currency: string;
  charge?: string | null;
  payment_intent?: string | null;
  reason: string;
  status: string;
  created: number;
  livemode: boolean;
}

export interface StripeBalanceLike {
  available: Array<{ amount: number; currency: string }>;
  pending: Array<{ amount: number; currency: string }>;
  livemode: boolean;
}

export interface StripeBalanceTransactionLike {
  id: string;
  amount: number;
  currency: string;
  description?: string | null;
  fee: number;
  net: number;
  status: string;
  type: string;
  created: number;
  available_on?: number;
}

// ---------------------------------------------------------------------------
// Method shapes — every endpoint our tools touch. Each resource has the
// narrow signatures we need.
// ---------------------------------------------------------------------------

interface CustomersResource {
  create(params: {
    email?: string;
    name?: string;
    description?: string;
    phone?: string;
    metadata?: Record<string, string>;
  }): Promise<StripeCustomerLike>;
  retrieve(id: string): Promise<StripeCustomerLike>;
  list(params?: {
    limit?: number;
    email?: string;
    starting_after?: string;
  }): Promise<StripeListResponse<StripeCustomerLike>>;
}

interface ProductsResource {
  create(params: {
    name: string;
    description?: string;
    active?: boolean;
    metadata?: Record<string, string>;
  }): Promise<StripeProductLike>;
  list(params?: {
    limit?: number;
    active?: boolean;
    starting_after?: string;
  }): Promise<StripeListResponse<StripeProductLike>>;
}

interface PricesResource {
  create(params: {
    currency: string;
    unit_amount: number;
    product: string;
    nickname?: string;
    recurring?: { interval: "day" | "week" | "month" | "year"; interval_count?: number };
  }): Promise<StripePriceLike>;
  list(params?: {
    limit?: number;
    product?: string;
    active?: boolean;
    starting_after?: string;
  }): Promise<StripeListResponse<StripePriceLike>>;
}

interface PaymentLinksResource {
  create(params: {
    line_items: Array<{ price: string; quantity: number }>;
    metadata?: Record<string, string>;
  }): Promise<StripePaymentLinkLike>;
}

interface PaymentIntentsResource {
  retrieve(id: string): Promise<StripePaymentIntentLike>;
  list(params?: {
    limit?: number;
    customer?: string;
    starting_after?: string;
  }): Promise<StripeListResponse<StripePaymentIntentLike>>;
  cancel(
    id: string,
    params?: {
      cancellation_reason?:
        | "duplicate"
        | "fraudulent"
        | "requested_by_customer"
        | "abandoned";
    },
  ): Promise<StripePaymentIntentLike>;
}

interface ChargesResource {
  retrieve(id: string): Promise<StripeChargeLike>;
  list(params?: {
    limit?: number;
    customer?: string;
    payment_intent?: string;
    starting_after?: string;
  }): Promise<StripeListResponse<StripeChargeLike>>;
}

interface RefundsResource {
  create(params: {
    charge?: string;
    payment_intent?: string;
    amount?: number;
    reason?: "duplicate" | "fraudulent" | "requested_by_customer";
  }): Promise<StripeRefundLike>;
  retrieve(id: string): Promise<StripeRefundLike>;
  list(params?: {
    limit?: number;
    charge?: string;
    payment_intent?: string;
    starting_after?: string;
  }): Promise<StripeListResponse<StripeRefundLike>>;
}

interface SubscriptionsResource {
  retrieve(id: string): Promise<StripeSubscriptionLike>;
  list(params?: {
    limit?: number;
    customer?: string;
    status?: "active" | "canceled" | "past_due" | "trialing" | "all";
    starting_after?: string;
  }): Promise<StripeListResponse<StripeSubscriptionLike>>;
  cancel(
    id: string,
    params?: { invoice_now?: boolean; prorate?: boolean },
  ): Promise<StripeSubscriptionLike>;
}

interface InvoicesResource {
  retrieve(id: string): Promise<StripeInvoiceLike>;
  list(params?: {
    limit?: number;
    customer?: string;
    status?: "draft" | "open" | "paid" | "uncollectible" | "void";
    starting_after?: string;
  }): Promise<StripeListResponse<StripeInvoiceLike>>;
  finalizeInvoice(id: string): Promise<StripeInvoiceLike>;
  voidInvoice(id: string): Promise<StripeInvoiceLike>;
}

interface DisputesResource {
  retrieve(id: string): Promise<StripeDisputeLike>;
  list(params?: {
    limit?: number;
    charge?: string;
    payment_intent?: string;
    starting_after?: string;
  }): Promise<StripeListResponse<StripeDisputeLike>>;
}

interface BalanceResource {
  retrieve(): Promise<StripeBalanceLike>;
}

interface BalanceTransactionsResource {
  list(params?: {
    limit?: number;
    type?: string;
    starting_after?: string;
  }): Promise<StripeListResponse<StripeBalanceTransactionLike>>;
}

/** Narrow Stripe client surface — only the methods our tools touch. */
export interface StripeClientLike {
  customers: CustomersResource;
  products: ProductsResource;
  prices: PricesResource;
  paymentLinks: PaymentLinksResource;
  paymentIntents: PaymentIntentsResource;
  charges: ChargesResource;
  refunds: RefundsResource;
  subscriptions: SubscriptionsResource;
  invoices: InvoicesResource;
  disputes: DisputesResource;
  balance: BalanceResource;
  balanceTransactions: BalanceTransactionsResource;
}

/** Synchronous factory used by StripeClientWrapper; swappable in tests. */
export type ClientFactory = (apiKey: string) => StripeClientLike;

/**
 * Pinned Stripe API version used by this voice. Pinning means a
 * dashboard-side version bump cannot silently change the response shapes
 * we format. Override via `apiVersion` if you have a tighter pin.
 */
export const DEFAULT_API_VERSION: Stripe.LatestApiVersion = "2025-08-27.basil";

function defaultFactory(apiKey: string): StripeClientLike {
  // The real Stripe class is structurally compatible with our narrow
  // surface — every resource we declare is on the instance with matching
  // signatures. Cast through `unknown` once at this boundary.
  return new Stripe(apiKey, {
    apiVersion: DEFAULT_API_VERSION,
    maxNetworkRetries: 2,
  }) as unknown as StripeClientLike;
}

/**
 * Singleton wrapper around a {@link Stripe} client. Created lazily on the
 * first tool call; subsequent calls share the same instance. Stripe's
 * Node SDK is stateless HTTP under the hood, so there is no connection
 * to keep alive — but we still memoise so we don't repeatedly spin up
 * retry queues and idempotency caches.
 */
export class StripeClientWrapper {
  private client?: StripeClientLike;
  private initPromise?: Promise<StripeClientLike>;

  constructor(
    private readonly apiKey: string,
    private readonly factory: ClientFactory = defaultFactory,
  ) {}

  async getClient(): Promise<StripeClientLike> {
    if (this.client) return this.client;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const c = this.factory(this.apiKey);
      this.client = c;
      return c;
    })();

    try {
      return await this.initPromise;
    } catch (err) {
      this.initPromise = undefined;
      throw err;
    }
  }

  async destroy(): Promise<void> {
    this.client = undefined;
    this.initPromise = undefined;
  }
}

/** Config for creating a StripeClient. */
export interface StripeClientOptions {
  /** Secret API key (`sk_test_...` or `sk_live_...`). Defaults to STRIPE_SECRET_KEY. */
  api_key?: string;
  /** Custom client factory — primarily for tests. */
  clientFactory?: ClientFactory;
}

/** Resolved client state — usable or an explanatory missing placeholder. */
export type StripeClient =
  | { kind: "ready"; wrapper: StripeClientWrapper; livemode: boolean }
  | { kind: "missing"; message: string };

/**
 * Resolve credentials from options then env. Never throws — returns
 * `kind: "missing"` when STRIPE_SECRET_KEY is unset so individual tool
 * calls can surface a helpful message without crashing the voice at
 * construction time.
 */
export function createStripeClient(options: StripeClientOptions = {}): StripeClient {
  const api_key = options.api_key ?? SecretsManager.optional("STRIPE_SECRET_KEY");
  if (!api_key) {
    return {
      kind: "missing",
      message:
        "Stripe voice is not configured. Set STRIPE_SECRET_KEY to a Stripe secret API key from https://dashboard.stripe.com/apikeys. Use a 'sk_test_' key against the Stripe test mode while developing — every destructive tool here will move real money on a live key.",
    };
  }

  return {
    kind: "ready",
    wrapper: new StripeClientWrapper(api_key, options.clientFactory),
    livemode: api_key.startsWith("sk_live_"),
  };
}
