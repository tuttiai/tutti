import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { modeBadge, stripeErrorMessage } from "../utils/format.js";

const parameters = z.object({
  email: z.string().email().optional().describe("Customer email address"),
  name: z.string().min(1).max(256).optional().describe("Customer's full name"),
  description: z.string().max(350).optional().describe("Internal description"),
  phone: z.string().optional().describe("E.164 phone number"),
  metadata: z.record(z.string(), z.string()).optional().describe("Up to 50 string key/value pairs"),
});

export function createCreateCustomerTool(client: StripeClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "create_customer",
    description: "Create a new Stripe customer.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const params: {
          email?: string;
          name?: string;
          description?: string;
          phone?: string;
          metadata?: Record<string, string>;
        } = {};
        if (input.email) params.email = input.email;
        if (input.name) params.name = input.name;
        if (input.description) params.description = input.description;
        if (input.phone) params.phone = input.phone;
        if (input.metadata) params.metadata = input.metadata;
        const cust = await c.customers.create(params);
        return {
          content: `Created customer ${cust.id}${modeBadge(cust.livemode)}${cust.email ? ` (${cust.email})` : ""}`,
        };
      } catch (error) {
        return { content: stripeErrorMessage(error, "create_customer"), is_error: true };
      }
    },
  };
}
