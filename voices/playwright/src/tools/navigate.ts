import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { BrowserManager } from "../browser.js";
import { pwErrorMessage } from "../utils/format.js";
import { UrlSanitizer } from "../utils/sanitize.js";

const parameters = z.object({
  url: z.string().url().describe("Full URL including protocol"),
  wait_until: z
    .enum(["load", "domcontentloaded", "networkidle"])
    .default("load")
    .describe("When to consider navigation complete"),
});

export function createNavigateTool(browser: BrowserManager): Tool<z.infer<typeof parameters>> {
  return {
    name: "navigate",
    description: "Navigate the browser to a URL",
    parameters,
    execute: async (input) => {
      try {
        UrlSanitizer.validate(input.url);
        const page = await browser.getPage();
        await page.goto(input.url, { waitUntil: input.wait_until });
        const title = await page.title();
        const finalUrl = page.url();
        return { content: `Navigated to ${finalUrl}\nTitle: ${title}` };
      } catch (error) {
        return { content: pwErrorMessage(error), is_error: true };
      }
    },
  };
}
