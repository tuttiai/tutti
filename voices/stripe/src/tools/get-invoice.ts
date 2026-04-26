import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatAmount, formatTime, modeBadge, stripeErrorMessage } from "../utils/format.js";

const parameters = z.object({
  invoice_id: z.string().min(1).describe("Invoice id (e.g. 'in_...')"),
});

export function createGetInvoiceTool(client: StripeClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "get_invoice",
    description: "Fetch a single Stripe invoice with totals, status, hosted URL, and PDF link.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const inv = await c.invoices.retrieve(input.invoice_id);
        const lines = [
          `${inv.id}${inv.number ? ` (${inv.number})` : ""}${modeBadge(inv.livemode)}`,
          `Status: ${inv.status ?? "?"}`,
          `Customer: ${inv.customer ?? "(none)"}`,
          `Total: ${formatAmount(inv.total, inv.currency)}`,
          `Amount due: ${formatAmount(inv.amount_due, inv.currency)}`,
          `Amount paid: ${formatAmount(inv.amount_paid, inv.currency)}`,
          `Amount remaining: ${formatAmount(inv.amount_remaining, inv.currency)}`,
          inv.due_date ? `Due: ${formatTime(inv.due_date)}` : null,
          inv.hosted_invoice_url ? `Hosted URL: ${inv.hosted_invoice_url}` : null,
          inv.invoice_pdf ? `PDF: ${inv.invoice_pdf}` : null,
          `Created: ${formatTime(inv.created)}`,
        ].filter((l): l is string => l !== null);
        return { content: lines.join("\n") };
      } catch (error) {
        return { content: stripeErrorMessage(error, `invoice ${input.invoice_id}`), is_error: true };
      }
    },
  };
}
