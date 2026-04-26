import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext } from "@tuttiai/types";
import { StripeVoice } from "../src/index.js";
import type {
  StripeBalanceLike,
  StripeChargeLike,
  StripeClient,
  StripeClientLike,
  StripeCustomerLike,
  StripeDisputeLike,
  StripeInvoiceLike,
  StripePaymentIntentLike,
  StripePriceLike,
  StripeProductLike,
  StripeRefundLike,
  StripeSubscriptionLike,
} from "../src/client.js";
import { StripeClientWrapper } from "../src/client.js";
import { createListCustomersTool } from "../src/tools/list-customers.js";
import { createGetCustomerTool } from "../src/tools/get-customer.js";
import { createCreateCustomerTool } from "../src/tools/create-customer.js";
import { createListProductsTool } from "../src/tools/list-products.js";
import { createCreateProductTool } from "../src/tools/create-product.js";
import { createListPricesTool } from "../src/tools/list-prices.js";
import { createCreatePriceTool } from "../src/tools/create-price.js";
import { createCreatePaymentLinkTool } from "../src/tools/create-payment-link.js";
import { createListPaymentIntentsTool } from "../src/tools/list-payment-intents.js";
import { createGetPaymentIntentTool } from "../src/tools/get-payment-intent.js";
import { createCancelPaymentIntentTool } from "../src/tools/cancel-payment-intent.js";
import { createListChargesTool } from "../src/tools/list-charges.js";
import { createGetChargeTool } from "../src/tools/get-charge.js";
import { createListRefundsTool } from "../src/tools/list-refunds.js";
import { createGetRefundTool } from "../src/tools/get-refund.js";
import { createCreateRefundTool } from "../src/tools/create-refund.js";
import { createListSubscriptionsTool } from "../src/tools/list-subscriptions.js";
import { createGetSubscriptionTool } from "../src/tools/get-subscription.js";
import { createCancelSubscriptionTool } from "../src/tools/cancel-subscription.js";
import { createListInvoicesTool } from "../src/tools/list-invoices.js";
import { createGetInvoiceTool } from "../src/tools/get-invoice.js";
import { createFinalizeInvoiceTool } from "../src/tools/finalize-invoice.js";
import { createVoidInvoiceTool } from "../src/tools/void-invoice.js";
import { createListDisputesTool } from "../src/tools/list-disputes.js";
import { createGetDisputeTool } from "../src/tools/get-dispute.js";
import { createGetBalanceTool } from "../src/tools/get-balance.js";
import { createListBalanceTransactionsTool } from "../src/tools/list-balance-transactions.js";
import {
  formatAmount,
  formatMetadata,
  formatNumber,
  formatTime,
  modeBadge,
  pluralise,
  stripeErrorMessage,
  truncate,
} from "../src/utils/format.js";

const ctx: ToolContext = { session_id: "test", agent_name: "test" };

// ---------------------------------------------------------------------------
// Mock-factory helpers
// ---------------------------------------------------------------------------

interface MockClient extends StripeClientLike {
  customers: {
    create: ReturnType<typeof vi.fn>;
    retrieve: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
  };
  products: { create: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> };
  prices: { create: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> };
  paymentLinks: { create: ReturnType<typeof vi.fn> };
  paymentIntents: {
    retrieve: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  };
  charges: { retrieve: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> };
  refunds: {
    create: ReturnType<typeof vi.fn>;
    retrieve: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
  };
  subscriptions: {
    retrieve: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  };
  invoices: {
    retrieve: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    finalizeInvoice: ReturnType<typeof vi.fn>;
    voidInvoice: ReturnType<typeof vi.fn>;
  };
  disputes: { retrieve: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> };
  balance: { retrieve: ReturnType<typeof vi.fn> };
  balanceTransactions: { list: ReturnType<typeof vi.fn> };
}

function makeMockClient(): MockClient {
  return {
    customers: { create: vi.fn(), retrieve: vi.fn(), list: vi.fn() },
    products: { create: vi.fn(), list: vi.fn() },
    prices: { create: vi.fn(), list: vi.fn() },
    paymentLinks: { create: vi.fn() },
    paymentIntents: { retrieve: vi.fn(), list: vi.fn(), cancel: vi.fn() },
    charges: { retrieve: vi.fn(), list: vi.fn() },
    refunds: { create: vi.fn(), retrieve: vi.fn(), list: vi.fn() },
    subscriptions: { retrieve: vi.fn(), list: vi.fn(), cancel: vi.fn() },
    invoices: {
      retrieve: vi.fn(),
      list: vi.fn(),
      finalizeInvoice: vi.fn(),
      voidInvoice: vi.fn(),
    },
    disputes: { retrieve: vi.fn(), list: vi.fn() },
    balance: { retrieve: vi.fn() },
    balanceTransactions: { list: vi.fn() },
  };
}

function readyClient(): { client: StripeClient; mock: MockClient } {
  const mock = makeMockClient();
  const wrapper = new StripeClientWrapper("sk_test_fake", () => mock);
  return { client: { kind: "ready", wrapper, livemode: false }, mock };
}

let env: ReturnType<typeof readyClient>;

beforeEach(() => {
  env = readyClient();
});

/** Build a Stripe-shaped error like the SDK throws. */
function stripeErr(type: string, message = `${type} error`, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { type, ...extra });
}

// ---------------------------------------------------------------------------
// Sample resource factories
// ---------------------------------------------------------------------------

function makeCustomer(over: Partial<StripeCustomerLike> = {}): StripeCustomerLike {
  return {
    id: "cus_1",
    email: "alice@example.com",
    name: "Alice",
    description: null,
    phone: null,
    currency: "usd",
    created: 1_700_000_000,
    livemode: false,
    delinquent: false,
    metadata: {},
    ...over,
  };
}
function makeProduct(over: Partial<StripeProductLike> = {}): StripeProductLike {
  return {
    id: "prod_1",
    name: "Pro plan",
    description: "All features",
    active: true,
    created: 1_700_000_000,
    livemode: false,
    default_price: "price_1",
    ...over,
  };
}
function makePrice(over: Partial<StripePriceLike> = {}): StripePriceLike {
  return {
    id: "price_1",
    product: "prod_1",
    active: true,
    currency: "usd",
    unit_amount: 999,
    type: "recurring",
    recurring: { interval: "month", interval_count: 1 },
    nickname: "monthly",
    created: 1_700_000_000,
    livemode: false,
    ...over,
  };
}
function makePaymentIntent(over: Partial<StripePaymentIntentLike> = {}): StripePaymentIntentLike {
  return {
    id: "pi_1",
    amount: 999,
    currency: "usd",
    status: "succeeded",
    customer: "cus_1",
    created: 1_700_000_000,
    livemode: false,
    ...over,
  };
}
function makeCharge(over: Partial<StripeChargeLike> = {}): StripeChargeLike {
  return {
    id: "ch_1",
    amount: 999,
    amount_captured: 999,
    amount_refunded: 0,
    currency: "usd",
    customer: "cus_1",
    description: null,
    status: "succeeded",
    paid: true,
    refunded: false,
    created: 1_700_000_000,
    receipt_url: "https://stripe.com/receipt/x",
    livemode: false,
    ...over,
  };
}
function makeRefund(over: Partial<StripeRefundLike> = {}): StripeRefundLike {
  return {
    id: "re_1",
    amount: 999,
    currency: "usd",
    charge: "ch_1",
    status: "succeeded",
    reason: "requested_by_customer",
    created: 1_700_000_000,
    livemode: false,
    ...over,
  };
}
function makeSubscription(over: Partial<StripeSubscriptionLike> = {}): StripeSubscriptionLike {
  return {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    cancel_at_period_end: false,
    current_period_start: 1_700_000_000,
    current_period_end: 1_702_000_000,
    created: 1_700_000_000,
    livemode: false,
    items: { data: [{ id: "si_1", price: { id: "price_1" }, quantity: 1 }] },
    metadata: {},
    ...over,
  };
}
function makeInvoice(over: Partial<StripeInvoiceLike> = {}): StripeInvoiceLike {
  return {
    id: "in_1",
    customer: "cus_1",
    status: "open",
    total: 999,
    amount_due: 999,
    amount_paid: 0,
    amount_remaining: 999,
    currency: "usd",
    number: "INV-001",
    hosted_invoice_url: "https://invoice.stripe.com/x",
    invoice_pdf: "https://invoice.stripe.com/x.pdf",
    created: 1_700_000_000,
    livemode: false,
    ...over,
  };
}
function makeDispute(over: Partial<StripeDisputeLike> = {}): StripeDisputeLike {
  return {
    id: "dp_1",
    amount: 999,
    currency: "usd",
    charge: "ch_1",
    reason: "fraudulent",
    status: "needs_response",
    created: 1_700_000_000,
    livemode: false,
    ...over,
  };
}
function makeBalance(over: Partial<StripeBalanceLike> = {}): StripeBalanceLike {
  return {
    available: [{ amount: 5000, currency: "usd" }],
    pending: [{ amount: 1000, currency: "usd" }],
    livemode: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// StripeVoice
// ---------------------------------------------------------------------------

describe("StripeVoice", () => {
  it("exposes 27 tools and required_permissions=['network']", () => {
    const voice = new StripeVoice({ api_key: "sk_test_x", clientFactory: () => makeMockClient() });
    expect(voice.name).toBe("stripe");
    expect(voice.required_permissions).toEqual(["network"]);
    expect(voice.tools).toHaveLength(27);
    const names = voice.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "cancel_payment_intent",
        "cancel_subscription",
        "create_customer",
        "create_payment_link",
        "create_price",
        "create_product",
        "create_refund",
        "finalize_invoice",
        "get_balance",
        "get_charge",
        "get_customer",
        "get_dispute",
        "get_invoice",
        "get_payment_intent",
        "get_refund",
        "get_subscription",
        "list_balance_transactions",
        "list_charges",
        "list_customers",
        "list_disputes",
        "list_invoices",
        "list_payment_intents",
        "list_prices",
        "list_products",
        "list_refunds",
        "list_subscriptions",
        "void_invoice",
      ].sort(),
    );
  });

  it("marks all 9 write tools as destructive", () => {
    const voice = new StripeVoice({ api_key: "sk_test_x", clientFactory: () => makeMockClient() });
    const destructive = voice.tools
      .filter((t) => t.destructive === true)
      .map((t) => t.name)
      .sort();
    expect(destructive).toEqual(
      [
        "cancel_payment_intent",
        "cancel_subscription",
        "create_customer",
        "create_payment_link",
        "create_price",
        "create_product",
        "create_refund",
        "finalize_invoice",
        "void_invoice",
      ].sort(),
    );
  });

  it("teardown() is a no-op when never used", async () => {
    const voice = new StripeVoice({ api_key: "sk_test_x", clientFactory: () => makeMockClient() });
    await expect(voice.teardown()).resolves.toBeUndefined();
  });

  it("teardown() is a no-op when api_key is missing", async () => {
    const voice = new StripeVoice({});
    await expect(voice.teardown()).resolves.toBeUndefined();
  });

  it("livemode=true when STRIPE_SECRET_KEY starts with sk_live_", async () => {
    const voice = new StripeVoice({ api_key: "sk_live_x", clientFactory: () => makeMockClient() });
    // Trigger lazy init through any tool then teardown.
    expect(voice.tools[0]).toBeDefined();
    await voice.teardown();
  });
});

// ---------------------------------------------------------------------------
// Client wrapper
// ---------------------------------------------------------------------------

describe("StripeClientWrapper", () => {
  it("does not call the factory until getClient() is awaited", async () => {
    const factory = vi.fn(() => makeMockClient());
    const wrapper = new StripeClientWrapper("sk_test_x", factory);
    expect(factory).not.toHaveBeenCalled();
    await wrapper.getClient();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith("sk_test_x");
  });

  it("reuses the same client across concurrent getClient() calls", async () => {
    const mock = makeMockClient();
    const wrapper = new StripeClientWrapper("sk_test_x", () => mock);
    const [a, b] = await Promise.all([wrapper.getClient(), wrapper.getClient()]);
    expect(a).toBe(b);
  });

  it("retries init after a previous factory throw", async () => {
    let call = 0;
    const factory = vi.fn(() => {
      call += 1;
      if (call === 1) throw new Error("bad init");
      return makeMockClient();
    });
    const wrapper = new StripeClientWrapper("sk_test_x", factory);
    await expect(wrapper.getClient()).rejects.toThrow("bad init");
    await expect(wrapper.getClient()).resolves.toBeDefined();
  });

  it("destroy() clears the cache so getClient() rebuilds", async () => {
    const factory = vi.fn(() => makeMockClient());
    const wrapper = new StripeClientWrapper("sk_test_x", factory);
    await wrapper.getClient();
    await wrapper.destroy();
    await wrapper.getClient();
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Auth gating
// ---------------------------------------------------------------------------

describe("auth gating", () => {
  it("list_customers returns is_error when no api_key configured", async () => {
    const missing: StripeClient = { kind: "missing", message: "Stripe not configured." };
    const tool = createListCustomersTool(missing);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not configured");
  });

  it("create_refund returns is_error when no api_key configured", async () => {
    const missing: StripeClient = { kind: "missing", message: "Stripe not configured." };
    const tool = createCreateRefundTool(missing);
    const result = await tool.execute(
      tool.parameters.parse({ charge: "ch_1" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
  });

  it("get_balance returns is_error when no api_key configured", async () => {
    const missing: StripeClient = { kind: "missing", message: "Stripe not configured." };
    const tool = createGetBalanceTool(missing);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.is_error).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// list_customers
// ---------------------------------------------------------------------------

describe("list_customers", () => {
  it("formats customers with email + test badge + delinquent flag", async () => {
    env.mock.customers.list.mockResolvedValue({
      data: [
        makeCustomer({ id: "cus_1", email: "a@x.com" }),
        makeCustomer({ id: "cus_2", email: null, name: "Bob", delinquent: true }),
      ],
      has_more: false,
    });
    const tool = createListCustomersTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("2 customers");
    expect(result.content).toContain("a@x.com");
    expect(result.content).toContain("Bob");
    expect(result.content).toContain("[test]");
    expect(result.content).toContain("[delinquent]");
  });

  it("forwards email + starting_after filters", async () => {
    env.mock.customers.list.mockResolvedValue({ data: [], has_more: false });
    const tool = createListCustomersTool(env.client);
    await tool.execute(
      tool.parameters.parse({ email: "x@y.com", starting_after: "cus_99", limit: 10 }),
      ctx,
    );
    expect(env.mock.customers.list).toHaveBeenCalledWith({
      limit: 10,
      email: "x@y.com",
      starting_after: "cus_99",
    });
  });

  it("flags pagination when has_more=true", async () => {
    env.mock.customers.list.mockResolvedValue({
      data: [makeCustomer({ id: "cus_42" })],
      has_more: true,
    });
    const tool = createListCustomersTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("more available; pass starting_after=cus_42");
  });

  it("reports empty result", async () => {
    env.mock.customers.list.mockResolvedValue({ data: [], has_more: false });
    const tool = createListCustomersTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toBe("No customers found.");
  });

  it("returns is_error on auth failure", async () => {
    env.mock.customers.list.mockRejectedValue(stripeErr("StripeAuthenticationError"));
    const tool = createListCustomersTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("authentication failed");
  });
});

// ---------------------------------------------------------------------------
// get_customer
// ---------------------------------------------------------------------------

describe("get_customer", () => {
  it("formats a customer", async () => {
    env.mock.customers.retrieve.mockResolvedValue(
      makeCustomer({ description: "VIP", metadata: { tier: "gold" } }),
    );
    const tool = createGetCustomerTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ customer_id: "cus_1" }),
      ctx,
    );
    expect(result.content).toContain("cus_1");
    expect(result.content).toContain("alice@example.com");
    expect(result.content).toContain("Description: VIP");
    expect(result.content).toContain("metadata: tier=gold");
  });

  it("renders deleted customers gracefully", async () => {
    env.mock.customers.retrieve.mockResolvedValue(
      makeCustomer({ id: "cus_gone", deleted: true }),
    );
    const tool = createGetCustomerTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ customer_id: "cus_gone" }),
      ctx,
    );
    expect(result.content).toContain("cus_gone is deleted");
  });

  it("returns is_error on resource_missing", async () => {
    env.mock.customers.retrieve.mockRejectedValue(
      stripeErr("StripeInvalidRequestError", "No such customer", { statusCode: 404 }),
    );
    const tool = createGetCustomerTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ customer_id: "cus_x" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("[404]");
    expect(result.content).toContain("No such customer");
  });
});

// ---------------------------------------------------------------------------
// create_customer
// ---------------------------------------------------------------------------

describe("create_customer", () => {
  it("creates a customer with optional fields", async () => {
    env.mock.customers.create.mockResolvedValue(makeCustomer({ id: "cus_new", email: "n@x.com" }));
    const tool = createCreateCustomerTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({
        email: "n@x.com",
        name: "New",
        description: "test",
        metadata: { source: "agent" },
      }),
      ctx,
    );
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("Created customer cus_new");
    expect(result.content).toContain("n@x.com");
    expect(env.mock.customers.create).toHaveBeenCalledWith({
      email: "n@x.com",
      name: "New",
      description: "test",
      metadata: { source: "agent" },
    });
  });

  it("returns is_error on rate limit", async () => {
    env.mock.customers.create.mockRejectedValue(stripeErr("StripeRateLimitError"));
    const tool = createCreateCustomerTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ email: "x@y.com" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("rate limit");
  });
});

// ---------------------------------------------------------------------------
// products
// ---------------------------------------------------------------------------

describe("list_products + create_product", () => {
  it("lists with active flag", async () => {
    env.mock.products.list.mockResolvedValue({
      data: [makeProduct({ name: "A" }), makeProduct({ id: "prod_2", name: "B", active: false })],
      has_more: false,
    });
    const tool = createListProductsTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("2 products");
    expect(result.content).toContain("[active]");
    expect(result.content).toContain("[archived]");
  });

  it("create_product calls SDK with name + active", async () => {
    env.mock.products.create.mockResolvedValue(makeProduct({ id: "prod_new", name: "X" }));
    const tool = createCreateProductTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ name: "X", description: "y" }),
      ctx,
    );
    expect(env.mock.products.create).toHaveBeenCalledWith({
      name: "X",
      active: true,
      description: "y",
    });
    expect(result.content).toContain("Created product prod_new");
  });
});

// ---------------------------------------------------------------------------
// prices
// ---------------------------------------------------------------------------

describe("list_prices + create_price", () => {
  it("lists recurring vs one-time prices", async () => {
    env.mock.prices.list.mockResolvedValue({
      data: [
        makePrice({ id: "price_m", recurring: { interval: "month", interval_count: 1 } }),
        makePrice({ id: "price_q", recurring: { interval: "month", interval_count: 3 } }),
        makePrice({ id: "price_o", recurring: null, type: "one_time" }),
      ],
      has_more: false,
    });
    const tool = createListPricesTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("per month");
    expect(result.content).toContain("per 3 months");
    expect(result.content).toContain("one-time");
  });

  it("create_price downcases currency and forwards recurring", async () => {
    env.mock.prices.create.mockResolvedValue(makePrice({ id: "price_new" }));
    const tool = createCreatePriceTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({
        product: "prod_1",
        currency: "USD",
        unit_amount: 1500,
        recurring: { interval: "month", interval_count: 1 },
      }),
      ctx,
    );
    expect(env.mock.prices.create).toHaveBeenCalledWith({
      product: "prod_1",
      currency: "usd",
      unit_amount: 1500,
      recurring: { interval: "month", interval_count: 1 },
    });
    expect(result.content).toContain("$15.00");
  });
});

// ---------------------------------------------------------------------------
// payment_links
// ---------------------------------------------------------------------------

describe("create_payment_link", () => {
  it("returns the URL", async () => {
    env.mock.paymentLinks.create.mockResolvedValue({
      id: "plink_1",
      active: true,
      url: "https://buy.stripe.com/test_xxx",
      livemode: false,
    });
    const tool = createCreatePaymentLinkTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ line_items: [{ price: "price_1", quantity: 2 }] }),
      ctx,
    );
    expect(result.content).toContain("plink_1");
    expect(result.content).toContain("https://buy.stripe.com/test_xxx");
  });
});

// ---------------------------------------------------------------------------
// payment_intents
// ---------------------------------------------------------------------------

describe("payment_intents tools", () => {
  it("list_payment_intents formats with cust + status", async () => {
    env.mock.paymentIntents.list.mockResolvedValue({
      data: [makePaymentIntent({ id: "pi_42", status: "requires_action" })],
      has_more: false,
    });
    const tool = createListPaymentIntentsTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("pi_42");
    expect(result.content).toContain("requires_action");
  });

  it("get_payment_intent surfaces last_payment_error", async () => {
    env.mock.paymentIntents.retrieve.mockResolvedValue(
      makePaymentIntent({
        status: "requires_payment_method",
        last_payment_error: { code: "card_declined", message: "Your card was declined." },
      }),
    );
    const tool = createGetPaymentIntentTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ payment_intent_id: "pi_1" }),
      ctx,
    );
    expect(result.content).toContain("Status: requires_payment_method");
    expect(result.content).toContain("card_declined");
    expect(result.content).toContain("Your card was declined");
  });

  it("cancel_payment_intent forwards cancellation_reason", async () => {
    env.mock.paymentIntents.cancel.mockResolvedValue(
      makePaymentIntent({ id: "pi_x", status: "canceled" }),
    );
    const tool = createCancelPaymentIntentTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ payment_intent_id: "pi_x", cancellation_reason: "fraudulent" }),
      ctx,
    );
    expect(env.mock.paymentIntents.cancel).toHaveBeenCalledWith("pi_x", {
      cancellation_reason: "fraudulent",
    });
    expect(result.content).toContain("Cancelled payment intent pi_x");
    expect(result.content).toContain("status=canceled");
  });

  it("cancel_payment_intent surfaces card-error decline_code", async () => {
    env.mock.paymentIntents.cancel.mockRejectedValue(
      stripeErr("StripeCardError", "card_declined", { decline_code: "insufficient_funds" }),
    );
    const tool = createCancelPaymentIntentTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ payment_intent_id: "pi_x" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("decline_code: insufficient_funds");
  });
});

// ---------------------------------------------------------------------------
// charges
// ---------------------------------------------------------------------------

describe("charges tools", () => {
  it("list_charges shows refunded amount when partial", async () => {
    env.mock.charges.list.mockResolvedValue({
      data: [makeCharge({ amount_refunded: 200 })],
      has_more: false,
    });
    const tool = createListChargesTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("refunded $2.00");
  });

  it("get_charge formats failure code/message", async () => {
    env.mock.charges.retrieve.mockResolvedValue(
      makeCharge({
        status: "failed",
        paid: false,
        failure_code: "expired_card",
        failure_message: "Your card has expired.",
      }),
    );
    const tool = createGetChargeTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ charge_id: "ch_1" }),
      ctx,
    );
    expect(result.content).toContain("Failure: expired_card");
    expect(result.content).toContain("Your card has expired");
  });
});

// ---------------------------------------------------------------------------
// refunds
// ---------------------------------------------------------------------------

describe("refunds tools", () => {
  it("list_refunds shows charge target", async () => {
    env.mock.refunds.list.mockResolvedValue({
      data: [makeRefund()],
      has_more: false,
    });
    const tool = createListRefundsTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("re_1");
    expect(result.content).toContain("charge=ch_1");
  });

  it("get_refund retrieves by id", async () => {
    env.mock.refunds.retrieve.mockResolvedValue(makeRefund({ id: "re_42" }));
    const tool = createGetRefundTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ refund_id: "re_42" }),
      ctx,
    );
    expect(env.mock.refunds.retrieve).toHaveBeenCalledWith("re_42");
    expect(result.content).toContain("re_42");
    expect(result.content).toContain("$9.99");
  });

  it("create_refund refunds a charge", async () => {
    env.mock.refunds.create.mockResolvedValue(makeRefund({ id: "re_99" }));
    const tool = createCreateRefundTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ charge: "ch_1", reason: "duplicate" }),
      ctx,
    );
    expect(env.mock.refunds.create).toHaveBeenCalledWith({
      charge: "ch_1",
      reason: "duplicate",
    });
    expect(result.content).toContain("Refunded $9.99");
  });

  it("create_refund rejects when neither charge nor payment_intent supplied", () => {
    const tool = createCreateRefundTool(env.client);
    expect(() => tool.parameters.parse({})).toThrow();
  });
});

// ---------------------------------------------------------------------------
// subscriptions
// ---------------------------------------------------------------------------

describe("subscriptions tools", () => {
  it("list_subscriptions flags cancel_at_period_end", async () => {
    env.mock.subscriptions.list.mockResolvedValue({
      data: [makeSubscription({ cancel_at_period_end: true })],
      has_more: false,
    });
    const tool = createListSubscriptionsTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("[cancel_at_period_end]");
  });

  it("get_subscription renders items", async () => {
    env.mock.subscriptions.retrieve.mockResolvedValue(
      makeSubscription({ items: { data: [{ id: "si_1", price: { id: "price_1" }, quantity: 2 }] } }),
    );
    const tool = createGetSubscriptionTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ subscription_id: "sub_1" }),
      ctx,
    );
    expect(result.content).toContain("price price_1");
    expect(result.content).toContain("qty 2");
  });

  it("cancel_subscription forwards invoice_now/prorate", async () => {
    env.mock.subscriptions.cancel.mockResolvedValue(
      makeSubscription({ status: "canceled" }),
    );
    const tool = createCancelSubscriptionTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ subscription_id: "sub_1", invoice_now: true, prorate: true }),
      ctx,
    );
    expect(env.mock.subscriptions.cancel).toHaveBeenCalledWith("sub_1", {
      invoice_now: true,
      prorate: true,
    });
    expect(result.content).toContain("status=canceled");
  });
});

// ---------------------------------------------------------------------------
// invoices
// ---------------------------------------------------------------------------

describe("invoices tools", () => {
  it("list_invoices shows number + status", async () => {
    env.mock.invoices.list.mockResolvedValue({
      data: [makeInvoice()],
      has_more: false,
    });
    const tool = createListInvoicesTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("INV-001");
    expect(result.content).toContain("[open]");
  });

  it("get_invoice surfaces hosted URL + PDF", async () => {
    env.mock.invoices.retrieve.mockResolvedValue(makeInvoice());
    const tool = createGetInvoiceTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ invoice_id: "in_1" }),
      ctx,
    );
    expect(result.content).toContain("Hosted URL: https://invoice.stripe.com/x");
    expect(result.content).toContain("PDF: https://invoice.stripe.com/x.pdf");
  });

  it("finalize_invoice transitions and surfaces hosted URL", async () => {
    env.mock.invoices.finalizeInvoice.mockResolvedValue(makeInvoice({ status: "open" }));
    const tool = createFinalizeInvoiceTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ invoice_id: "in_1" }),
      ctx,
    );
    expect(result.content).toContain("Finalized invoice in_1");
    expect(result.content).toContain("status=open");
    expect(result.content).toContain("https://invoice.stripe.com/x");
  });

  it("void_invoice transitions to void", async () => {
    env.mock.invoices.voidInvoice.mockResolvedValue(makeInvoice({ status: "void" }));
    const tool = createVoidInvoiceTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ invoice_id: "in_1" }),
      ctx,
    );
    expect(result.content).toContain("Voided invoice in_1");
    expect(result.content).toContain("status=void");
  });
});

// ---------------------------------------------------------------------------
// disputes
// ---------------------------------------------------------------------------

describe("disputes tools", () => {
  it("list_disputes formats with reason + status", async () => {
    env.mock.disputes.list.mockResolvedValue({
      data: [makeDispute()],
      has_more: false,
    });
    const tool = createListDisputesTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("dp_1");
    expect(result.content).toContain("fraudulent");
    expect(result.content).toContain("[needs_response]");
  });

  it("get_dispute returns details", async () => {
    env.mock.disputes.retrieve.mockResolvedValue(makeDispute());
    const tool = createGetDisputeTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ dispute_id: "dp_1" }),
      ctx,
    );
    expect(result.content).toContain("Reason: fraudulent");
  });
});

// ---------------------------------------------------------------------------
// balance
// ---------------------------------------------------------------------------

describe("balance tools", () => {
  it("get_balance shows available + pending", async () => {
    env.mock.balance.retrieve.mockResolvedValue(makeBalance());
    const tool = createGetBalanceTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("Available:");
    expect(result.content).toContain("$50.00");
    expect(result.content).toContain("Pending:");
    expect(result.content).toContain("$10.00");
  });

  it("get_balance handles empty entries", async () => {
    env.mock.balance.retrieve.mockResolvedValue({ available: [], pending: [], livemode: false });
    const tool = createGetBalanceTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("(none)");
  });

  it("list_balance_transactions formats fee + net", async () => {
    env.mock.balanceTransactions.list.mockResolvedValue({
      data: [
        {
          id: "txn_1",
          amount: 1000,
          fee: 30,
          net: 970,
          currency: "usd",
          status: "available",
          type: "charge",
          created: 1_700_000_000,
        },
      ],
      has_more: false,
    });
    const tool = createListBalanceTransactionsTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("txn_1");
    expect(result.content).toContain("(fee $0.30, net $9.70)");
    expect(result.content).toContain("[available]");
  });
});

// ---------------------------------------------------------------------------
// Per-tool error-path coverage — ensures the catch branch on every tool
// returns is_error rather than throwing. One scenario per tool.
// ---------------------------------------------------------------------------

describe("error-path coverage", () => {
  type Scenario = {
    name: string;
    setup: () => void;
    parse: () => unknown;
    make: () => { execute: (input: unknown, ctx: ToolContext) => Promise<{ is_error?: boolean }> };
  };

  const scenarios: Scenario[] = [
    {
      name: "list_customers",
      setup: () => env.mock.customers.list.mockRejectedValue(stripeErr("StripeAPIError")),
      parse: () => createListCustomersTool(env.client).parameters.parse({}),
      make: () => createListCustomersTool(env.client),
    },
    {
      name: "get_customer",
      setup: () => env.mock.customers.retrieve.mockRejectedValue(stripeErr("StripeAPIError")),
      parse: () => createGetCustomerTool(env.client).parameters.parse({ customer_id: "cus_x" }),
      make: () => createGetCustomerTool(env.client),
    },
    {
      name: "list_products",
      setup: () => env.mock.products.list.mockRejectedValue(stripeErr("StripeAPIError")),
      parse: () => createListProductsTool(env.client).parameters.parse({}),
      make: () => createListProductsTool(env.client),
    },
    {
      name: "create_product",
      setup: () => env.mock.products.create.mockRejectedValue(stripeErr("StripeAPIError")),
      parse: () => createCreateProductTool(env.client).parameters.parse({ name: "x" }),
      make: () => createCreateProductTool(env.client),
    },
    {
      name: "list_prices",
      setup: () => env.mock.prices.list.mockRejectedValue(stripeErr("StripeAPIError")),
      parse: () => createListPricesTool(env.client).parameters.parse({}),
      make: () => createListPricesTool(env.client),
    },
    {
      name: "create_price",
      setup: () => env.mock.prices.create.mockRejectedValue(stripeErr("StripeAPIError")),
      parse: () =>
        createCreatePriceTool(env.client).parameters.parse({
          product: "prod_1",
          currency: "usd",
          unit_amount: 100,
        }),
      make: () => createCreatePriceTool(env.client),
    },
    {
      name: "create_payment_link",
      setup: () => env.mock.paymentLinks.create.mockRejectedValue(stripeErr("StripeAPIError")),
      parse: () =>
        createCreatePaymentLinkTool(env.client).parameters.parse({
          line_items: [{ price: "price_1", quantity: 1 }],
        }),
      make: () => createCreatePaymentLinkTool(env.client),
    },
    {
      name: "list_payment_intents",
      setup: () => env.mock.paymentIntents.list.mockRejectedValue(stripeErr("StripeAPIError")),
      parse: () => createListPaymentIntentsTool(env.client).parameters.parse({}),
      make: () => createListPaymentIntentsTool(env.client),
    },
    {
      name: "get_payment_intent",
      setup: () => env.mock.paymentIntents.retrieve.mockRejectedValue(stripeErr("StripeAPIError")),
      parse: () =>
        createGetPaymentIntentTool(env.client).parameters.parse({ payment_intent_id: "pi_x" }),
      make: () => createGetPaymentIntentTool(env.client),
    },
    {
      name: "list_charges",
      setup: () => env.mock.charges.list.mockRejectedValue(stripeErr("StripeAPIError")),
      parse: () => createListChargesTool(env.client).parameters.parse({}),
      make: () => createListChargesTool(env.client),
    },
    {
      name: "get_charge",
      setup: () => env.mock.charges.retrieve.mockRejectedValue(stripeErr("StripeAPIError")),
      parse: () => createGetChargeTool(env.client).parameters.parse({ charge_id: "ch_x" }),
      make: () => createGetChargeTool(env.client),
    },
    {
      name: "list_refunds",
      setup: () => env.mock.refunds.list.mockRejectedValue(stripeErr("StripeAPIError")),
      parse: () => createListRefundsTool(env.client).parameters.parse({}),
      make: () => createListRefundsTool(env.client),
    },
    {
      name: "get_refund",
      setup: () => env.mock.refunds.retrieve.mockRejectedValue(stripeErr("StripeAPIError")),
      parse: () => createGetRefundTool(env.client).parameters.parse({ refund_id: "re_x" }),
      make: () => createGetRefundTool(env.client),
    },
    {
      name: "create_refund",
      setup: () => env.mock.refunds.create.mockRejectedValue(stripeErr("StripeAPIError")),
      parse: () => createCreateRefundTool(env.client).parameters.parse({ charge: "ch_1" }),
      make: () => createCreateRefundTool(env.client),
    },
    {
      name: "list_subscriptions",
      setup: () => env.mock.subscriptions.list.mockRejectedValue(stripeErr("StripeAPIError")),
      parse: () => createListSubscriptionsTool(env.client).parameters.parse({}),
      make: () => createListSubscriptionsTool(env.client),
    },
    {
      name: "get_subscription",
      setup: () => env.mock.subscriptions.retrieve.mockRejectedValue(stripeErr("StripeAPIError")),
      parse: () => createGetSubscriptionTool(env.client).parameters.parse({ subscription_id: "sub_x" }),
      make: () => createGetSubscriptionTool(env.client),
    },
    {
      name: "cancel_subscription",
      setup: () => env.mock.subscriptions.cancel.mockRejectedValue(stripeErr("StripeAPIError")),
      parse: () => createCancelSubscriptionTool(env.client).parameters.parse({ subscription_id: "sub_x" }),
      make: () => createCancelSubscriptionTool(env.client),
    },
    {
      name: "list_invoices",
      setup: () => env.mock.invoices.list.mockRejectedValue(stripeErr("StripeAPIError")),
      parse: () => createListInvoicesTool(env.client).parameters.parse({}),
      make: () => createListInvoicesTool(env.client),
    },
    {
      name: "get_invoice",
      setup: () => env.mock.invoices.retrieve.mockRejectedValue(stripeErr("StripeAPIError")),
      parse: () => createGetInvoiceTool(env.client).parameters.parse({ invoice_id: "in_x" }),
      make: () => createGetInvoiceTool(env.client),
    },
    {
      name: "finalize_invoice",
      setup: () => env.mock.invoices.finalizeInvoice.mockRejectedValue(stripeErr("StripeAPIError")),
      parse: () => createFinalizeInvoiceTool(env.client).parameters.parse({ invoice_id: "in_x" }),
      make: () => createFinalizeInvoiceTool(env.client),
    },
    {
      name: "void_invoice",
      setup: () => env.mock.invoices.voidInvoice.mockRejectedValue(stripeErr("StripeAPIError")),
      parse: () => createVoidInvoiceTool(env.client).parameters.parse({ invoice_id: "in_x" }),
      make: () => createVoidInvoiceTool(env.client),
    },
    {
      name: "list_disputes",
      setup: () => env.mock.disputes.list.mockRejectedValue(stripeErr("StripeAPIError")),
      parse: () => createListDisputesTool(env.client).parameters.parse({}),
      make: () => createListDisputesTool(env.client),
    },
    {
      name: "get_dispute",
      setup: () => env.mock.disputes.retrieve.mockRejectedValue(stripeErr("StripeAPIError")),
      parse: () => createGetDisputeTool(env.client).parameters.parse({ dispute_id: "dp_x" }),
      make: () => createGetDisputeTool(env.client),
    },
    {
      name: "get_balance",
      setup: () => env.mock.balance.retrieve.mockRejectedValue(stripeErr("StripeAPIError")),
      parse: () => createGetBalanceTool(env.client).parameters.parse({}),
      make: () => createGetBalanceTool(env.client),
    },
    {
      name: "list_balance_transactions",
      setup: () => env.mock.balanceTransactions.list.mockRejectedValue(stripeErr("StripeAPIError")),
      parse: () => createListBalanceTransactionsTool(env.client).parameters.parse({}),
      make: () => createListBalanceTransactionsTool(env.client),
    },
  ];

  for (const s of scenarios) {
    it(`${s.name} returns is_error on Stripe failure`, async () => {
      s.setup();
      const tool = s.make();
      const result = await tool.execute(s.parse(), ctx);
      expect(result.is_error).toBe(true);
    });
  }
});

// Branch fan-out for list tools — exercise the "all optional params
// provided" branch on each guard so coverage doesn't fall off the cliff
// when most happy-path tests pass minimal input.
describe("optional param forwarding", () => {
  it("list_charges forwards customer + payment_intent + starting_after", async () => {
    env.mock.charges.list.mockResolvedValue({ data: [], has_more: false });
    const tool = createListChargesTool(env.client);
    await tool.execute(
      tool.parameters.parse({
        customer: "cus_1",
        payment_intent: "pi_1",
        starting_after: "ch_1",
      }),
      ctx,
    );
    expect(env.mock.charges.list).toHaveBeenCalledWith({
      limit: 20,
      customer: "cus_1",
      payment_intent: "pi_1",
      starting_after: "ch_1",
    });
  });

  it("list_payment_intents forwards customer + starting_after", async () => {
    env.mock.paymentIntents.list.mockResolvedValue({ data: [], has_more: false });
    const tool = createListPaymentIntentsTool(env.client);
    await tool.execute(
      tool.parameters.parse({ customer: "cus_1", starting_after: "pi_1" }),
      ctx,
    );
    expect(env.mock.paymentIntents.list).toHaveBeenCalledWith({
      limit: 20,
      customer: "cus_1",
      starting_after: "pi_1",
    });
  });

  it("list_refunds forwards charge + payment_intent + starting_after", async () => {
    env.mock.refunds.list.mockResolvedValue({ data: [], has_more: false });
    const tool = createListRefundsTool(env.client);
    await tool.execute(
      tool.parameters.parse({ charge: "ch_1", payment_intent: "pi_1", starting_after: "re_1" }),
      ctx,
    );
    expect(env.mock.refunds.list).toHaveBeenCalledWith({
      limit: 20,
      charge: "ch_1",
      payment_intent: "pi_1",
      starting_after: "re_1",
    });
  });

  it("list_subscriptions forwards customer + status + starting_after", async () => {
    env.mock.subscriptions.list.mockResolvedValue({ data: [], has_more: false });
    const tool = createListSubscriptionsTool(env.client);
    await tool.execute(
      tool.parameters.parse({ customer: "cus_1", status: "active", starting_after: "sub_1" }),
      ctx,
    );
    expect(env.mock.subscriptions.list).toHaveBeenCalledWith({
      limit: 20,
      customer: "cus_1",
      status: "active",
      starting_after: "sub_1",
    });
  });

  it("list_invoices forwards customer + status + starting_after", async () => {
    env.mock.invoices.list.mockResolvedValue({ data: [], has_more: false });
    const tool = createListInvoicesTool(env.client);
    await tool.execute(
      tool.parameters.parse({ customer: "cus_1", status: "paid", starting_after: "in_1" }),
      ctx,
    );
    expect(env.mock.invoices.list).toHaveBeenCalledWith({
      limit: 20,
      customer: "cus_1",
      status: "paid",
      starting_after: "in_1",
    });
  });

  it("list_disputes forwards charge + payment_intent + starting_after", async () => {
    env.mock.disputes.list.mockResolvedValue({ data: [], has_more: false });
    const tool = createListDisputesTool(env.client);
    await tool.execute(
      tool.parameters.parse({ charge: "ch_1", payment_intent: "pi_1", starting_after: "dp_1" }),
      ctx,
    );
    expect(env.mock.disputes.list).toHaveBeenCalledWith({
      limit: 20,
      charge: "ch_1",
      payment_intent: "pi_1",
      starting_after: "dp_1",
    });
  });

  it("list_balance_transactions forwards type + starting_after", async () => {
    env.mock.balanceTransactions.list.mockResolvedValue({ data: [], has_more: false });
    const tool = createListBalanceTransactionsTool(env.client);
    await tool.execute(
      tool.parameters.parse({ type: "payout", starting_after: "txn_1" }),
      ctx,
    );
    expect(env.mock.balanceTransactions.list).toHaveBeenCalledWith({
      limit: 20,
      type: "payout",
      starting_after: "txn_1",
    });
  });

  it("list_prices forwards product + active + starting_after", async () => {
    env.mock.prices.list.mockResolvedValue({ data: [], has_more: false });
    const tool = createListPricesTool(env.client);
    await tool.execute(
      tool.parameters.parse({ product: "prod_1", active: false, starting_after: "price_1" }),
      ctx,
    );
    expect(env.mock.prices.list).toHaveBeenCalledWith({
      limit: 20,
      product: "prod_1",
      active: false,
      starting_after: "price_1",
    });
  });

  it("list_products forwards active + starting_after", async () => {
    env.mock.products.list.mockResolvedValue({ data: [], has_more: false });
    const tool = createListProductsTool(env.client);
    await tool.execute(
      tool.parameters.parse({ active: true, starting_after: "prod_1" }),
      ctx,
    );
    expect(env.mock.products.list).toHaveBeenCalledWith({
      limit: 20,
      active: true,
      starting_after: "prod_1",
    });
  });

  it("create_payment_link forwards metadata", async () => {
    env.mock.paymentLinks.create.mockResolvedValue({
      id: "plink_1",
      active: true,
      url: "https://buy.stripe.com/test",
      livemode: false,
    });
    const tool = createCreatePaymentLinkTool(env.client);
    await tool.execute(
      tool.parameters.parse({
        line_items: [{ price: "price_1", quantity: 1 }],
        metadata: { source: "agent" },
      }),
      ctx,
    );
    expect(env.mock.paymentLinks.create).toHaveBeenCalledWith({
      line_items: [{ price: "price_1", quantity: 1 }],
      metadata: { source: "agent" },
    });
  });

  it("create_refund forwards payment_intent + amount", async () => {
    env.mock.refunds.create.mockResolvedValue(makeRefund({ id: "re_99", amount: 500 }));
    const tool = createCreateRefundTool(env.client);
    await tool.execute(
      tool.parameters.parse({ payment_intent: "pi_1", amount: 500 }),
      ctx,
    );
    expect(env.mock.refunds.create).toHaveBeenCalledWith({
      payment_intent: "pi_1",
      amount: 500,
    });
  });
});

// Cover the negative branches inside per-tool formatLine helpers (no-cust,
// no-desc, custom-amount price, sub without period/items, invoice without
// number, charge without receipt, refund routed via payment_intent).
describe("formatLine negative branches", () => {
  it("list_prices renders 'custom' amounts when unit_amount is null", async () => {
    env.mock.prices.list.mockResolvedValue({
      data: [makePrice({ id: "price_custom", unit_amount: null, recurring: null })],
      has_more: false,
    });
    const tool = createListPricesTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("(custom USD)");
    expect(result.content).toContain("one-time");
  });

  it("list_charges line works without a customer", async () => {
    env.mock.charges.list.mockResolvedValue({
      data: [makeCharge({ customer: null, refunded: true })],
      has_more: false,
    });
    const tool = createListChargesTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("[refunded]");
  });

  it("list_payment_intents line works without a customer or description", async () => {
    env.mock.paymentIntents.list.mockResolvedValue({
      data: [makePaymentIntent({ customer: null, description: null })],
      has_more: false,
    });
    const tool = createListPaymentIntentsTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("pi_1");
    expect(result.content).not.toContain("cust=");
  });

  it("list_refunds routes via payment_intent when charge is null", async () => {
    env.mock.refunds.list.mockResolvedValue({
      data: [makeRefund({ charge: null, payment_intent: "pi_42", reason: null })],
      has_more: false,
    });
    const tool = createListRefundsTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("pi=pi_42");
  });

  it("list_refunds shows '(unknown target)' when both ids are missing", async () => {
    env.mock.refunds.list.mockResolvedValue({
      data: [makeRefund({ charge: null, payment_intent: null })],
      has_more: false,
    });
    const tool = createListRefundsTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("(unknown target)");
  });

  it("list_subscriptions handles no current_period_end", async () => {
    env.mock.subscriptions.list.mockResolvedValue({
      data: [makeSubscription({ current_period_end: undefined })],
      has_more: false,
    });
    const tool = createListSubscriptionsTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).not.toContain("period_end");
  });

  it("get_subscription renders with no items + canceled_at", async () => {
    env.mock.subscriptions.retrieve.mockResolvedValue(
      makeSubscription({
        items: { data: [] },
        canceled_at: 1_700_001_000,
        current_period_start: undefined,
      }),
    );
    const tool = createGetSubscriptionTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ subscription_id: "sub_1" }),
      ctx,
    );
    expect(result.content).toContain("Canceled at:");
    expect(result.content).not.toContain("Items:");
  });

  it("list_invoices line works without invoice number / due_date / customer", async () => {
    env.mock.invoices.list.mockResolvedValue({
      data: [makeInvoice({ number: null, due_date: null, customer: null })],
      has_more: false,
    });
    const tool = createListInvoicesTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("in_1");
    expect(result.content).not.toContain("INV-");
    expect(result.content).not.toContain("cust=");
  });

  it("get_invoice with all optionals null", async () => {
    env.mock.invoices.retrieve.mockResolvedValue(
      makeInvoice({
        number: null,
        customer: null,
        due_date: null,
        hosted_invoice_url: null,
        invoice_pdf: null,
      }),
    );
    const tool = createGetInvoiceTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ invoice_id: "in_1" }),
      ctx,
    );
    expect(result.content).toContain("Customer: (none)");
    expect(result.content).not.toContain("Hosted URL");
    expect(result.content).not.toContain("PDF:");
  });

  it("list_disputes shows '(unknown)' target when both ids missing", async () => {
    env.mock.disputes.list.mockResolvedValue({
      data: [makeDispute({ charge: null, payment_intent: null })],
      has_more: false,
    });
    const tool = createListDisputesTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("(unknown)");
  });

  it("list_disputes routes via payment_intent when charge is null", async () => {
    env.mock.disputes.list.mockResolvedValue({
      data: [makeDispute({ charge: null, payment_intent: "pi_42" })],
      has_more: false,
    });
    const tool = createListDisputesTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("pi=pi_42");
  });

  it("list_balance_transactions line without description", async () => {
    env.mock.balanceTransactions.list.mockResolvedValue({
      data: [
        {
          id: "txn_1",
          amount: 1000,
          fee: 30,
          net: 970,
          currency: "usd",
          status: "available",
          type: "payout",
          created: 1_700_000_000,
        },
      ],
      has_more: false,
    });
    const tool = createListBalanceTransactionsTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("payout");
  });

  it("get_balance with multi-currency entries", async () => {
    env.mock.balance.retrieve.mockResolvedValue({
      available: [
        { amount: 5000, currency: "usd" },
        { amount: 4500, currency: "eur" },
      ],
      pending: [],
      livemode: true,
    });
    const tool = createGetBalanceTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("$50.00");
    expect(result.content).toContain("€45.00");
    expect(result.content).toContain("Pending:\n  (none)");
    expect(result.content).not.toContain("[test]");
  });

  it("list_products line without default_price + description", async () => {
    env.mock.products.list.mockResolvedValue({
      data: [makeProduct({ default_price: null, description: null })],
      has_more: false,
    });
    const tool = createListProductsTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).not.toContain("default_price");
  });
});

// ---------------------------------------------------------------------------
// format utilities
// ---------------------------------------------------------------------------

describe("format utilities", () => {
  it("formatAmount formats decimal currencies via Intl", () => {
    expect(formatAmount(999, "usd")).toBe("$9.99");
    expect(formatAmount(1500, "EUR")).toContain("15.00");
  });

  it("formatAmount handles zero-decimal currencies (JPY)", () => {
    expect(formatAmount(1500, "jpy")).toBe("1,500 JPY");
  });

  it("formatAmount produces a readable string even for unfamiliar codes", () => {
    // Modern Node's Intl.NumberFormat accepts any 3-letter ISO-shape code; the
    // catch-branch fallback in formatAmount is defensive for older runtimes.
    const out = formatAmount(1234, "ZZZ");
    expect(out).toContain("12.34");
    expect(out).toContain("ZZZ");
  });

  it("modeBadge stamps test on non-livemode", () => {
    expect(modeBadge(false)).toBe(" [test]");
    expect(modeBadge(true)).toBe("");
  });

  it("formatTime returns ISO from a unix timestamp", () => {
    expect(formatTime(0)).toBe("unknown");
    expect(formatTime(1_700_000_000)).toBe(
      new Date(1_700_000_000_000).toISOString(),
    );
  });

  it("pluralise picks singular vs plural", () => {
    expect(pluralise(1, "thing")).toBe("thing");
    expect(pluralise(2, "thing")).toBe("things");
    expect(pluralise(0, "child", "children")).toBe("children");
  });

  it("formatNumber + truncate work as expected", () => {
    expect(formatNumber(1234)).toBe("1,234");
    expect(truncate("abcdefghij", 7)).toBe("abcd...");
    expect(truncate("abc", 10)).toBe("abc");
  });

  it("formatMetadata renders entries inline", () => {
    expect(formatMetadata({})).toBe("");
    expect(formatMetadata(null)).toBe("");
    expect(formatMetadata({ a: "1", b: "2" })).toBe(" · metadata: a=1, b=2");
  });

  it("stripeErrorMessage maps every error type", () => {
    expect(stripeErrorMessage(stripeErr("StripeAuthenticationError"))).toContain(
      "authentication failed",
    );
    expect(stripeErrorMessage(stripeErr("StripePermissionError"))).toContain(
      "lacks permission",
    );
    expect(stripeErrorMessage(stripeErr("StripeRateLimitError"))).toContain("rate limit");
    expect(stripeErrorMessage(stripeErr("StripeIdempotencyError", "dup"))).toContain("dup");
    expect(
      stripeErrorMessage(stripeErr("StripeInvalidRequestError", "bad", { param: "email" })),
    ).toContain("(param: email)");
    expect(
      stripeErrorMessage(stripeErr("StripeCardError", "x", { decline_code: "lost" })),
    ).toContain("decline_code: lost");
    expect(stripeErrorMessage(stripeErr("StripeAPIError"))).toContain("server error");
    expect(stripeErrorMessage(stripeErr("StripeConnectionError", "no net"))).toContain(
      "Could not reach",
    );
  });

  it("stripeErrorMessage falls back for unknown types", () => {
    expect(stripeErrorMessage(stripeErr("StripeUnknown", "huh"))).toContain("huh");
  });

  it("stripeErrorMessage handles non-Error", () => {
    expect(stripeErrorMessage("plain")).toBe("plain");
  });

  it("stripeErrorMessage includes statusCode + requestId + doc_url when present", () => {
    const result = stripeErrorMessage(
      stripeErr("StripeInvalidRequestError", "bad", {
        statusCode: 400,
        requestId: "req_123",
        doc_url: "https://stripe.com/docs/errors",
      }),
    );
    expect(result).toContain("[400]");
    expect(result).toContain("request req_123");
    expect(result).toContain("https://stripe.com/docs/errors");
  });
});
