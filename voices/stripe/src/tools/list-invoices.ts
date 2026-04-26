import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient, StripeInvoiceLike } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatAmount, formatTime, modeBadge, pluralise, stripeErrorMessage } from "../utils/format.js";

const parameters = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  customer: z.string().optional().describe("Filter to one customer id"),
  status: z
    .enum(["draft", "open", "paid", "uncollectible", "void"])
    .optional()
    .describe("Filter by invoice status"),
  starting_after: z.string().optional(),
});

function formatLine(inv: StripeInvoiceLike): string {
  const num = inv.number ? ` ${inv.number}` : "";
  const cust = inv.customer ? ` · cust=${inv.customer}` : "";
  const due = inv.due_date ? ` · due ${formatTime(inv.due_date)}` : "";
  return `${inv.id}${num} · ${formatAmount(inv.total, inv.currency)} [${inv.status ?? "?"}]${modeBadge(inv.livemode)}${cust}${due}`;
}

export function createListInvoicesTool(client: StripeClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_invoices",
    description: "List Stripe invoices (newest first). Filter by customer or status.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const params: {
          limit: number;
          customer?: string;
          status?: "draft" | "open" | "paid" | "uncollectible" | "void";
          starting_after?: string;
        } = { limit: input.limit };
        if (input.customer) params.customer = input.customer;
        if (input.status) params.status = input.status;
        if (input.starting_after) params.starting_after = input.starting_after;
        const res = await c.invoices.list(params);
        if (res.data.length === 0) return { content: "No invoices found." };

        const more = res.has_more ? ` (more available; pass starting_after=${res.data[res.data.length - 1]?.id})` : "";
        const header = `${res.data.length} ${pluralise(res.data.length, "invoice")}${more}:`;
        return { content: `${header}\n\n${res.data.map(formatLine).join("\n")}` };
      } catch (error) {
        return { content: stripeErrorMessage(error, "list_invoices"), is_error: true };
      }
    },
  };
}
