import { chromium, type Browser, type Page } from "playwright";

export interface BrowserOptions {
  headless?: boolean;
  slowMo?: number;
  timeout?: number;
}

export class BrowserManager {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private options: BrowserOptions;

  constructor(options: BrowserOptions = {}) {
    this.options = options;
  }

  async getPage(): Promise<Page> {
    if (!this.page) {
      this.browser = await chromium.launch({
        headless: this.options.headless ?? true,
        slowMo: this.options.slowMo,
      });
      this.page = await this.browser.newPage();
      this.page.setDefaultTimeout(this.options.timeout ?? 10000);
    }
    return this.page;
  }

  async close(): Promise<void> {
    await this.page?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.page = null;
    this.browser = null;
  }
}
