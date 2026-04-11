import type { Permission, Voice, Tool } from "@tuttiai/types";
import { BrowserManager } from "./browser.js";
import { createNavigateTool } from "./tools/navigate.js";
import { createClickTool } from "./tools/click.js";
import { createTypeTool } from "./tools/type.js";
import { createScreenshotTool } from "./tools/screenshot.js";
import { createGetTextTool } from "./tools/get-text.js";
import { createGetPageContentTool } from "./tools/get-page-content.js";
import { createWaitForTool } from "./tools/wait-for.js";
import { createSelectOptionTool } from "./tools/select-option.js";
import { createCheckElementTool } from "./tools/check-element.js";
import { createScrollTool } from "./tools/scroll.js";
import { createEvaluateTool } from "./tools/evaluate.js";
import { createGetAttributeTool } from "./tools/get-attribute.js";

export interface PlaywrightVoiceOptions {
  /** Run browser in headless mode (default: true). */
  headless?: boolean;
  /** Milliseconds between actions for debugging. */
  slowMo?: number;
  /** Default timeout in ms (default: 10000). */
  timeout?: number;
}

export class PlaywrightVoice implements Voice {
  name = "playwright";
  description = "Control a browser like a human — navigate, click, type, screenshot";
  required_permissions: Permission[] = ["network", "browser"];
  tools: Tool[];
  private browser: BrowserManager;

  constructor(options: PlaywrightVoiceOptions = {}) {
    this.browser = new BrowserManager(options);
    this.tools = [
      createNavigateTool(this.browser),
      createClickTool(this.browser),
      createTypeTool(this.browser),
      createScreenshotTool(this.browser),
      createGetTextTool(this.browser),
      createGetPageContentTool(this.browser),
      createWaitForTool(this.browser),
      createSelectOptionTool(this.browser),
      createCheckElementTool(this.browser),
      createScrollTool(this.browser),
      createEvaluateTool(this.browser),
      createGetAttributeTool(this.browser),
    ];
  }

  async teardown(): Promise<void> {
    await this.browser.close();
  }
}

export { BrowserManager, type BrowserOptions } from "./browser.js";
