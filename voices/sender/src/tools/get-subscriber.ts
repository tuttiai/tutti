import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { SenderClient } from "../client.js";
import { withClient } from "../utils/guard.js";
import { dataOf, subscriberLine } from "../utils/format.js";

const parameters = z.object({
  subscriber: z.string().min(1).describe("Subscriber email address or id"),
});

export function createGetSubscriberTool(client: SenderClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "get_subscriber",
    description: "Get one subscriber by email address or id, with status, groups and custom fields.",
    parameters,
    execute: (input) =>
      withClient(client, "get_subscriber", async (api) => {
        const res = await api.request({ method: "GET", path: `/subscribers/${encodeURIComponent(input.subscriber)}` });
        if (!res.ok) return { content: res.message, is_error: true };
        const sub = dataOf(res.data);
        const columns = Array.isArray(sub["columns"]) ? JSON.stringify(sub["columns"]) : "";
        return { content: `${subscriberLine(sub)}${columns ? `\nfields: ${columns}` : ""}` };
      }),
  };
}
