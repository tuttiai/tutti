import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { SenderClient } from "../client.js";
import { withClient } from "../utils/guard.js";
import { dataOf, str } from "../utils/format.js";

const parameters = z.object({
  title: z.string().min(1).max(255).describe("Group name"),
});

export function createCreateGroupTool(client: SenderClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "create_group",
    description: "Create an empty subscriber group.",
    parameters,
    execute: (input) =>
      withClient(client, "create_group", async (api) => {
        const res = await api.request({ method: "POST", path: "/groups", body: { title: input.title } });
        if (!res.ok) return { content: res.message, is_error: true };
        const g = dataOf(res.data);
        return { content: `Created group ${str(g, "id")} · ${str(g, "title") || input.title}` };
      }),
  };
}
