# @tuttiai/web

Web search voice for [Tutti](https://tutti-ai.com) — gives agents the ability to search the internet.

## Install

```bash
npm install @tuttiai/web
```

## Providers

The voice auto-selects the best available provider based on which API key is set:

| Priority | Provider | Env var | Key required | Notes |
|----------|----------|---------|-------------|-------|
| 1 | Brave Search | `BRAVE_SEARCH_API_KEY` | Yes | Best quality, up to 20 results |
| 2 | Serper.dev | `SERPER_API_KEY` | Yes | Google Search results |
| 3 | DuckDuckGo | — | No | Free tier, limited results (0–4) |

## Usage

```typescript
import { WebVoice } from "@tuttiai/web";

const score = defineScore({
  provider: new AnthropicProvider(),
  agents: {
    researcher: {
      name: "researcher",
      system_prompt: "You research topics using web search.",
      voices: [new WebVoice()],
      permissions: ["network"],
    },
  },
});
```

## Tools

### `web_search`

Search the web for current information.

**Parameters:**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `query` | `string` | — | Search query (natural language or keywords) |
| `limit` | `number` | `5` | Max results to return (1–20) |

**Returns:** Numbered list of results with title, URL, snippet, and published date.

## License

MIT
