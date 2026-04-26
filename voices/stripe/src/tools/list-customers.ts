import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient, StripeCustomerLike } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatTime, modeBadge, pluralise, stripeErrorMessage } from "../utils/format.js";

const parameters = z.object({
  limit: z.number().int().min(1).max(100).default(20).describe("Number of customers to return (max 100)"),
  email: z.string().email().optional().describe("Filter to customers with this exact email"),
  starting_after: z.string().optional().describe("Pagination cursor — id of the last customer from the previous page"),
});

function formatLine(c: StripeCustomerLike): string {
  const email = c.email ? c.email : "(no email)";
  const name = c.name ? ` · ${c.name}` : "";
  const delinquent = c.delinquent ? " [delinquent]" : "";
  return `${c.id} · ${email}${name}${modeBadge(c.livemode)}${delinquent} · created ${formatTime(c.created)}`;
}

export function createListCustomersTool(client: StripeClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_customers",
    description: "List Stripe customers, newest first. Filter by email or paginate with starting_after.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const params: { limit: number; email?: string; starting_after?: string } = { limit: input.limit };
        if (input.email) params.email = input.email;
        if (input.starting_after) params.starting_after = input.starting_after;
        const res = await c.customers.list(params);
        if (res.data.length === 0) return { content: "No customers found." };

        const more = res.has_more ? ` (more available; pass starting_after=${res.data[res.data.length - 1]?.id})` : "";
        const header = `${res.data.length} ${pluralise(res.data.length, "customer")}${more}:`;
        return { content: `${header}\n\n${res.data.map(formatLine).join("\n")}` };
      } catch (error) {
        return { content: stripeErrorMessage(error, "list_customers"), is_error: true };
      }
    },
  };
}
