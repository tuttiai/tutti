# @tuttiai/playwright

Browser automation voice for [Tutti](https://tutti-ai.com) — gives agents the ability to control a browser like a human for QA and testing.

## Install

```bash
npm install @tuttiai/playwright
npx playwright install chromium
```

## Usage

```ts
import { TuttiRuntime, AnthropicProvider, defineScore } from "@tuttiai/core";
import { PlaywrightVoice } from "@tuttiai/playwright";

const playwright = new PlaywrightVoice({ headless: true });

const score = defineScore({
  provider: new AnthropicProvider(),
  agents: {
    qa: {
      name: "QA Agent",
      model: "claude-sonnet-4-20250514",
      system_prompt: "You are a QA engineer. Test web apps thoroughly.",
      voices: [playwright],
      permissions: ["network", "browser"],
    },
  },
});

const tutti = new TuttiRuntime(score);
const result = await tutti.run("qa", "Test the login page at https://example.com");

// Always clean up the browser when done
await playwright.teardown();
```

## Tools

| Tool | Description |
|---|---|
| `navigate` | Navigate to a URL |
| `click` | Click an element |
| `type` | Type text into an input |
| `screenshot` | Take a screenshot |
| `get_text` | Get text content of an element |
| `get_page_content` | Get full page text, title, and URL |
| `wait_for` | Wait for an element or condition |
| `select_option` | Select from a dropdown |
| `check_element` | Check if an element exists and get its properties |
| `scroll` | Scroll the page or an element |
| `evaluate` | Execute JavaScript in the browser |
| `get_attribute` | Get an attribute value from an element |

## Options

```ts
new PlaywrightVoice({
  headless: true,   // run without visible browser (default: true)
  slowMo: 100,      // ms between actions for debugging
  timeout: 10000,   // default timeout in ms
})
```

## Links

- [Tutti](https://tutti-ai.com)
- [GitHub](https://github.com/tuttiai/tutti/tree/main/voices/playwright)
- [Voice Registry](https://tutti-ai.com/voices)

## License

Apache 2.0
