import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { BrowserManager } from "../browser.js";
import { pwErrorMessage } from "../utils/format.js";

const parameters = z.object({
  selector: z.string().describe("CSS selector or text selector"),
  wait_for: z
    .enum(["visible", "attached"])
    .default("visible")
    .describe("Wait for element to be in this state before clicking"),
});

export function createClickTool(browser: BrowserManager): Tool<z.infer<typeof parameters>> {
  return {
    name: "click",
    description: "Click an element on the page",
    parameters,
    execute: async (input) => {
      try {
        const page = await browser.getPage();
        const locator = page.locator(input.selector);
        await locator.waitFor({ state: input.wait_for });
        await locator.click();
        const tag = await locator.evaluate((el) => el.tagName.toLowerCase());
        const text = await locator.innerText().catch(() => "");
        const label = text ? ` "${text.slice(0, 50)}"` : "";
        return { content: `Clicked <${tag}>${label}` };
      } catch (error) {
        return { content: pwErrorMessage(error), is_error: true };
      }
    },
  };
}
