import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { BrowserManager } from "../browser.js";
import { pwErrorMessage } from "../utils/format.js";

const parameters = z.object({
  selector: z.string().describe("CSS selector"),
  all: z
    .boolean()
    .default(false)
    .describe("Get text from all matching elements"),
});

export function createGetTextTool(browser: BrowserManager): Tool<z.infer<typeof parameters>> {
  return {
    name: "get_text",
    description: "Get the text content of an element",
    parameters,
    execute: async (input) => {
      try {
        const page = await browser.getPage();

        if (input.all) {
          const texts = await page.locator(input.selector).allInnerTexts();
          if (texts.length === 0) {
            return { content: `No elements found matching "${input.selector}"` };
          }
          return { content: texts.join("\n") };
        }

        const text = await page.locator(input.selector).innerText();
        return { content: text };
      } catch (error) {
        return { content: pwErrorMessage(error, input.selector), is_error: true };
      }
    },
  };
}
