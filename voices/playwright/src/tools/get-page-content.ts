import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { BrowserManager } from "../browser.js";
import { pwErrorMessage } from "../utils/format.js";

const parameters = z.object({});

export function createGetPageContentTool(browser: BrowserManager): Tool<z.infer<typeof parameters>> {
  return {
    name: "get_page_content",
    description: "Get the full text content and URL of the current page",
    parameters,
    execute: async () => {
      try {
        const page = await browser.getPage();
        const url = page.url();
        const title = await page.title();
        const text = await page.locator("body").innerText();

        return {
          content: `URL: ${url}\nTitle: ${title}\n\n${text}`,
        };
      } catch (error) {
        return { content: pwErrorMessage(error), is_error: true };
      }
    },
  };
}
