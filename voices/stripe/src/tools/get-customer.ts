import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatMetadata, formatTime, modeBadge, stripeErrorMessage } from "../utils/format.js";

const parameters = z.object({
  customer_id: z.string().min(1).describe("Stripe customer id (e.g. 'cus_...')"),
});

export function createGetCustomerTool(client: StripeClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "get_customer",
    description: "Fetch a single Stripe customer by id with email, name, currency, and metadata.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const cust = await c.customers.retrieve(input.customer_id);
        if (cust.deleted) {
          return { content: `Customer ${cust.id} is deleted${modeBadge(cust.livemode)}.` };
        }
        const lines = [
          `${cust.id}${modeBadge(cust.livemode)}`,
          `Email: ${cust.email ?? "(none)"}`,
          `Name: ${cust.name ?? "(none)"}`,
          `Phone: ${cust.phone ?? "(none)"}`,
          `Currency: ${cust.currency?.toUpperCase() ?? "(none)"}`,
          `Description: ${cust.description ?? "(none)"}`,
          `Delinquent: ${cust.delinquent ? "yes" : "no"}`,
          `Created: ${formatTime(cust.created)}${formatMetadata(cust.metadata)}`,
        ];
        return { content: lines.join("\n") };
      } catch (error) {
        return { content: stripeErrorMessage(error, `customer ${input.customer_id}`), is_error: true };
      }
    },
  };
}
