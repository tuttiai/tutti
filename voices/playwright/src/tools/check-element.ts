import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { BrowserManager } from "../browser.js";
import { pwErrorMessage } from "../utils/format.js";

const parameters = z.object({
  selector: z.string().describe("CSS selector"),
});

export function createCheckElementTool(browser: BrowserManager): Tool<z.infer<typeof parameters>> {
  return {
    name: "check_element",
    description: "Check if an element exists and get its properties",
    parameters,
    execute: async (input) => {
      try {
        const page = await browser.getPage();
        const locator = page.locator(input.selector);
        const count = await locator.count();

        if (count === 0) {
          return { content: `Element "${input.selector}" not found on the page` };
        }

        const first = locator.first();
        const visible = await first.isVisible();
        const text = await first.innerText().catch(() => "");
        const tag = await first.evaluate((el) => el.tagName.toLowerCase());
        const attrs = await first.evaluate((el) => {
          const result: Record<string, string> = {};
          for (const attr of el.attributes) {
            result[attr.name] = attr.value;
          }
          return result;
        });

        const lines = [
          `Element: <${tag}>`,
          `Exists: true`,
          `Visible: ${visible}`,
          `Count: ${count}`,
          `Text: ${text.slice(0, 200) || "(empty)"}`,
          `Attributes: ${JSON.stringify(attrs)}`,
        ];

        return { content: lines.join("\n") };
      } catch (error) {
        return { content: pwErrorMessage(error), is_error: true };
      }
    },
  };
}
