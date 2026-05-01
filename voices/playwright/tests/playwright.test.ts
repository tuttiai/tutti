import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ToolContext } from "@tuttiai/types";
import { PlaywrightVoice } from "../src/index.js";
import { BrowserManager } from "../src/browser.js";
import { createNavigateTool } from "../src/tools/navigate.js";
import { createScreenshotTool } from "../src/tools/screenshot.js";
import { createGetTextTool } from "../src/tools/get-text.js";
import { createGetPageContentTool } from "../src/tools/get-page-content.js";
import { createCheckElementTool } from "../src/tools/check-element.js";
import { createGetAttributeTool } from "../src/tools/get-attribute.js";
import { createEvaluateTool } from "../src/tools/evaluate.js";
import { createScrollTool } from "../src/tools/scroll.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ctx: ToolContext = { session_id: "test", agent_name: "test" };

// Shared browser for integration tests — reused across all tests
const browser = new BrowserManager({ headless: true });

// UrlSanitizer blocks data: URLs, so we serve the test fixture over real http
// from a localhost server bound to an OS-assigned port.
let server: Server;
let TEST_URL = "";

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(TEST_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  TEST_URL = `http://127.0.0.1:${port}/`;
});

afterAll(async () => {
  await browser.close();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

// ---------------------------------------------------------------------------
// PlaywrightVoice
// ---------------------------------------------------------------------------

describe("PlaywrightVoice", () => {
  it("implements Voice with 12 tools", () => {
    const voice = new PlaywrightVoice();
    expect(voice.name).toBe("playwright");
    expect(voice.tools).toHaveLength(12);
    const names = voice.tools.map((t) => t.name);
    expect(names).toEqual([
      "navigate",
      "click",
      "type",
      "screenshot",
      "get_text",
      "get_page_content",
      "wait_for",
      "select_option",
      "check_element",
      "scroll",
      "evaluate",
      "get_attribute",
    ]);
  });

  it("has a teardown method", () => {
    const voice = new PlaywrightVoice();
    expect(typeof voice.teardown).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Integration tests — real browser on a data: URL
// ---------------------------------------------------------------------------

const TEST_HTML = `<!doctype html>
<html>
<head><title>Test Page</title></head>
<body>
  <h1 id="heading">Hello Tutti</h1>
  <p class="info">This is a test page.</p>
  <a id="link" href="https://tutti-ai.com">Visit Tutti</a>
  <input id="name" type="text" value="old value" />
  <button id="btn">Click Me</button>
</body>
</html>`;

describe("navigate", () => {
  it("navigates to a URL and returns title", async () => {
    const tool = createNavigateTool(browser);
    const result = await tool.execute(
      tool.parameters.parse({ url: TEST_URL }),
      ctx,
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("Test Page");
  });
});

describe("get_text", () => {
  it("gets text content of an element", async () => {
    const tool = createGetTextTool(browser);
    const result = await tool.execute(
      tool.parameters.parse({ selector: "#heading" }),
      ctx,
    );

    expect(result.content).toBe("Hello Tutti");
  });

  it("gets text from all matching elements", async () => {
    const tool = createGetTextTool(browser);
    const result = await tool.execute(
      tool.parameters.parse({ selector: "h1, p.info", all: true }),
      ctx,
    );

    expect(result.content).toContain("Hello Tutti");
    expect(result.content).toContain("This is a test page.");
  });
});

describe("get_page_content", () => {
  it("returns URL, title, and body text", async () => {
    const tool = createGetPageContentTool(browser);
    const result = await tool.execute(
      tool.parameters.parse({}),
      ctx,
    );

    expect(result.content).toContain("Title: Test Page");
    expect(result.content).toContain("Hello Tutti");
    expect(result.content).toContain("This is a test page.");
  });
});

describe("check_element", () => {
  it("returns element properties when found", async () => {
    const tool = createCheckElementTool(browser);
    const result = await tool.execute(
      tool.parameters.parse({ selector: "#heading" }),
      ctx,
    );

    expect(result.content).toContain("Element: <h1>");
    expect(result.content).toContain("Exists: true");
    expect(result.content).toContain("Visible: true");
    expect(result.content).toContain("Hello Tutti");
  });

  it("reports when element is not found", async () => {
    const tool = createCheckElementTool(browser);
    const result = await tool.execute(
      tool.parameters.parse({ selector: "#nonexistent" }),
      ctx,
    );

    expect(result.content).toContain("not found");
  });
});

describe("get_attribute", () => {
  it("returns an attribute value", async () => {
    const tool = createGetAttributeTool(browser);
    const result = await tool.execute(
      tool.parameters.parse({ selector: "#link", attribute: "href" }),
      ctx,
    );

    expect(result.content).toBe("https://tutti-ai.com");
  });

  it("reports missing attribute", async () => {
    const tool = createGetAttributeTool(browser);
    const result = await tool.execute(
      tool.parameters.parse({ selector: "#heading", attribute: "href" }),
      ctx,
    );

    expect(result.content).toContain("does not have attribute");
  });
});

describe("evaluate", () => {
  it("executes JS and returns the result", async () => {
    const tool = createEvaluateTool(browser);
    const result = await tool.execute(
      tool.parameters.parse({ script: "document.title" }),
      ctx,
    );

    expect(result.content).toBe("Test Page");
  });

  it("handles object return values", async () => {
    const tool = createEvaluateTool(browser);
    const result = await tool.execute(
      tool.parameters.parse({ script: "({ x: 1, y: 2 })" }),
      ctx,
    );

    expect(result.content).toContain('"x": 1');
    expect(result.content).toContain('"y": 2');
  });
});

describe("scroll", () => {
  it("scrolls without error", async () => {
    const tool = createScrollTool(browser);
    const result = await tool.execute(
      tool.parameters.parse({ direction: "down" }),
      ctx,
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("Scrolled down");
  });
});

describe("screenshot", () => {
  it("takes a screenshot and saves to file", async () => {
    const path = join(tmpdir(), `tutti-pw-test-${Date.now()}.png`);
    const tool = createScreenshotTool(browser);
    const result = await tool.execute(
      tool.parameters.parse({ path }),
      ctx,
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("Screenshot saved");
    expect(existsSync(path)).toBe(true);

    // Cleanup
    unlinkSync(path);
  });
});
