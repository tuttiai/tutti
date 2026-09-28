import { afterEach, describe, expect, it, vi } from "vitest";

const launch = vi.fn();

vi.mock("playwright", () => ({ chromium: { launch } }));

const { BrowserManager } = await import("../src/browser.js");

function fakeBrowser(): unknown {
  const page = { setDefaultTimeout: vi.fn(), close: vi.fn(async () => undefined) };
  return { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) };
}

describe("BrowserManager", () => {
  afterEach(() => {
    launch.mockReset();
  });

  describe("getPage", () => {
    it("launches the binary it was given", async () => {
      launch.mockResolvedValue(fakeBrowser());
      await new BrowserManager({ executablePath: "/usr/bin/chromium" }).getPage();
      expect(launch).toHaveBeenCalledWith(expect.objectContaining({ executablePath: "/usr/bin/chromium", headless: true }));
    });

    it("leaves Playwright to find its own browser when given none", async () => {
      launch.mockResolvedValue(fakeBrowser());
      await new BrowserManager({}).getPage();
      expect(launch.mock.calls[0]?.[0]).not.toHaveProperty("executablePath");
    });
  });
});
