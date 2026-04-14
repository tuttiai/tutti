# @tuttiai/web

Web voice for [Tutti](https://tutti-ai.com) — gives agents web search,
page fetching, and sitemap reading.

## Install

```bash
npm install @tuttiai/web
```

## Provider setup

Set one environment variable to enable a search provider.
The voice auto-selects the highest-priority key it finds:

| Priority | Provider | Env var | Free? |
|:--------:|----------|---------|:-----:|
| 1 | **Brave Search** | `BRAVE_SEARCH_API_KEY` | 2 000 free queries/month |
| 2 | **Serper.dev** | `SERPER_API_KEY` | 2 500 free queries/month |
| 3 | **DuckDuckGo** | *(none — no key needed)* | Unlimited, but limited results |

**Brave** — sign up at [brave.com/search/api](https://brave.com/search/api/).
Copy the key and add it to `.env`:

```bash
BRAVE_SEARCH_API_KEY=BSA...
```

**Serper** — sign up at [serper.dev](https://serper.dev/).
Copy the key:

```bash
SERPER_API_KEY=...
```

**DuckDuckGo** — no setup needed. The Instant Answer API returns an
abstract + 0–4 related topics, so it works best as a free-tier
fallback. Results are less comprehensive than the paid providers.

## Which provider should I use?

| Scenario | Recommended | Why |
|----------|-------------|-----|
| Production / research agents | Brave | Best result quality, fast, generous free tier |
| Google-indexed results needed | Serper | Proxies Google Search |
| Budget = $0, no API key | DuckDuckGo | Works out of the box, limited results |
| CI / testing | DuckDuckGo or mock | No key management in CI |

## Usage

```typescript
import { WebVoice } from "@tuttiai/web";
import { TuttiRuntime, AnthropicProvider, defineScore } from "@tuttiai/core";

const score = defineScore({
  name: "researcher",
  provider: new AnthropicProvider(),
  agents: {
    researcher: {
      name: "researcher",
      model: "claude-sonnet-4-20250514",
      system_prompt:
        "You are a research assistant. Use web_search to find current " +
        "information, fetch_url to read full articles, and " +
        "fetch_sitemap to discover pages on a site.",
      voices: [
        new WebVoice({
          provider: "brave",
          max_results: 10,
          rate_limit: { per_minute: 30 },
        }),
      ],
      permissions: ["network"],
    },
  },
});

const runtime = new TuttiRuntime(score);
const result = await runtime.run("researcher", "What happened in AI this week?");
```

## Configuration

```typescript
new WebVoice(config?: WebVoiceConfig)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `provider` | `"brave" \| "serper" \| "duckduckgo" \| SearchProvider` | auto-detect | Force a specific provider or pass a custom one |
| `cache` | `boolean` | `true` | Enable/disable the LRU result cache |
| `max_results` | `number` | `5` | Default result count for `web_search` (1–20) |
| `rate_limit` | `{ per_minute: number }` | none | Per-tool call budget (shared across all 3 tools) |
| `timeout_ms` | `number` | `5000` | HTTP request timeout for search providers |

## Tools

### `web_search`

Search the web and return top results.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | `string` | — | Natural-language or keyword query |
| `limit` | `number` | `5` (or `max_results` from config) | Results to return (1–20) |

**Returns:** Numbered list with title, URL, snippet, and date.
Results are cached for 10 minutes.

### `fetch_url`

Fetch a URL and return its content.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | `string` | — | URL to fetch |
| `timeout_ms` | `number` | `10000` | HTTP timeout |

- **HTML** — extracted to readable text via `@mozilla/readability`
  (strips nav, ads, boilerplate)
- **JSON** — pretty-printed
- **Text / Markdown** — returned as-is

Content is truncated to ~8 000 tokens. Cached for 30 minutes.

**Returns:** `{ url, title, content, content_type, fetched_at }`

### `fetch_sitemap`

Fetch a sitemap.xml and return all URLs.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | `string` | — | URL of sitemap.xml (or site root — `/sitemap.xml` is appended) |

Handles both `<urlset>` sitemaps and `<sitemapindex>` index files.
Cached for 30 minutes.

## Caching

An in-memory LRU cache (500 entries max) deduplicates repeated calls:

| Scope | TTL | Cache key |
|-------|-----|-----------|
| `web_search` | 10 min | `sha256(query \| provider)` |
| `fetch_url` | 30 min | `sha256(url)` |
| `fetch_sitemap` | 30 min | `sha256("sitemap" \| url)` |

## Rate limiting

When `rate_limit: { per_minute: N }` is set, a sliding-window counter
tracks calls per tool. If a tool exceeds `N` calls within 60 seconds,
the call returns `{ content: "Rate limit exceeded…", is_error: true }`
instead of throwing. Each tool is tracked independently.

## Security

All URLs are validated before fetching:
- Only `http://` and `https://` schemes allowed
- Loopback addresses (`localhost`, `127.0.0.1`, `::1`) blocked
- Private IP ranges (`10.x`, `172.16–31.x`, `192.168.x`) blocked

## License

MIT
