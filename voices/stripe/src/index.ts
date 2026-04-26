import type { Permission, Tool, Voice } from "@tuttiai/types";
import {
  createStripeClient,
  type StripeClient,
  type StripeClientOptions,
} from "./client.js";
import { createListCustomersTool } from "./tools/list-customers.js";
import { createGetCustomerTool } from "./tools/get-customer.js";
import { createCreateCustomerTool } from "./tools/create-customer.js";
import { createListProductsTool } from "./tools/list-products.js";
import { createCreateProductTool } from "./tools/create-product.js";
import { createListPricesTool } from "./tools/list-prices.js";
import { createCreatePriceTool } from "./tools/create-price.js";
import { createCreatePaymentLinkTool } from "./tools/create-payment-link.js";
import { createListPaymentIntentsTool } from "./tools/list-payment-intents.js";
import { createGetPaymentIntentTool } from "./tools/get-payment-intent.js";
import { createCancelPaymentIntentTool } from "./tools/cancel-payment-intent.js";
import { createListChargesTool } from "./tools/list-charges.js";
import { createGetChargeTool } from "./tools/get-charge.js";
import { createListRefundsTool } from "./tools/list-refunds.js";
import { createGetRefundTool } from "./tools/get-refund.js";
import { createCreateRefundTool } from "./tools/create-refund.js";
import { createListSubscriptionsTool } from "./tools/list-subscriptions.js";
import { createGetSubscriptionTool } from "./tools/get-subscription.js";
import { createCancelSubscriptionTool } from "./tools/cancel-subscription.js";
import { createListInvoicesTool } from "./tools/list-invoices.js";
import { createGetInvoiceTool } from "./tools/get-invoice.js";
import { createFinalizeInvoiceTool } from "./tools/finalize-invoice.js";
import { createVoidInvoiceTool } from "./tools/void-invoice.js";
import { createListDisputesTool } from "./tools/list-disputes.js";
import { createGetDisputeTool } from "./tools/get-dispute.js";
import { createGetBalanceTool } from "./tools/get-balance.js";
import { createListBalanceTransactionsTool } from "./tools/list-balance-transactions.js";

/** Options for {@link StripeVoice}. */
export interface StripeVoiceOptions extends StripeClientOptions {}

/**
 * Gives agents broad access to a Stripe account: customers, products,
 * prices, payment links, payment intents, charges, refunds,
 * subscriptions, invoices, disputes, and balance.
 *
 * Every write tool is marked `destructive: true` so HITL-enabled
 * runtimes gate them behind human approval before any state change —
 * critical here because a `create_refund` or `void_invoice` moves real
 * money on a `sk_live_` key.
 *
 * The Stripe SDK is created lazily on the first tool call. Stripe is
 * stateless HTTP, so {@link teardown} is a cache clear.
 */
export class StripeVoice implements Voice {
  name = "stripe";
  description = "Read and write Stripe data: customers, payments, subscriptions, invoices, balance";
  required_permissions: Permission[] = ["network"];
  tools: Tool[];

  private readonly client: StripeClient;

  constructor(options: StripeVoiceOptions = {}) {
    this.client = createStripeClient(options);
    this.tools = [
      createListCustomersTool(this.client),
      createGetCustomerTool(this.client),
      createCreateCustomerTool(this.client),
      createListProductsTool(this.client),
      createCreateProductTool(this.client),
      createListPricesTool(this.client),
      createCreatePriceTool(this.client),
      createCreatePaymentLinkTool(this.client),
      createListPaymentIntentsTool(this.client),
      createGetPaymentIntentTool(this.client),
      createCancelPaymentIntentTool(this.client),
      createListChargesTool(this.client),
      createGetChargeTool(this.client),
      createListRefundsTool(this.client),
      createGetRefundTool(this.client),
      createCreateRefundTool(this.client),
      createListSubscriptionsTool(this.client),
      createGetSubscriptionTool(this.client),
      createCancelSubscriptionTool(this.client),
      createListInvoicesTool(this.client),
      createGetInvoiceTool(this.client),
      createFinalizeInvoiceTool(this.client),
      createVoidInvoiceTool(this.client),
      createListDisputesTool(this.client),
      createGetDisputeTool(this.client),
      createGetBalanceTool(this.client),
      createListBalanceTransactionsTool(this.client),
    ];
  }

  async teardown(): Promise<void> {
    if (this.client.kind === "ready") {
      await this.client.wrapper.destroy();
    }
  }
}

export { createStripeClient, StripeClientWrapper, DEFAULT_API_VERSION } from "./client.js";
export type {
  StripeClient,
  StripeClientOptions,
  StripeClientLike,
  ClientFactory,
  StripeListResponse,
  StripeCustomerLike,
  StripeProductLike,
  StripePriceLike,
  StripePaymentLinkLike,
  StripePaymentIntentLike,
  StripeChargeLike,
  StripeRefundLike,
  StripeSubscriptionLike,
  StripeInvoiceLike,
  StripeDisputeLike,
  StripeBalanceLike,
  StripeBalanceTransactionLike,
} from "./client.js";
