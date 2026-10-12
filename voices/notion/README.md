# @tuttiai/notion

Notion voice for [Tutti](https://tutti-ai.com): search, read and write the pages and databases a
Notion internal integration has been given. It calls Notion's REST API directly with `fetch`,
pinned to `Notion-Version: 2022-06-28`, and adds no dependency beyond `zod`.

Notion shows an integration nothing until a person shares a page with it, so what the agent can
reach is decided in Notion, page by page. Sharing a page shares everything nested under it.

## Install

```bash
tutti-ai add notion
# or
npm install @tuttiai/notion
```

## Setup

1. Create an internal integration at <https://www.notion.so/profile/integrations> and copy its
   secret (`ntn_...`, or `secret_...` for older integrations).
2. Under the integration's **Capabilities**, enable what the agent needs: *Read content* for the
   read tools, *Update content* and *Insert content* for the write tools.
3. In Notion, open each page or database the agent should see, choose the **•••** menu, then
   **Connections**, and add the integration.

```
NOTION_TOKEN=ntn_...
```

## Quickstart

```ts
import { NotionVoice } from "@tuttiai/notion";

const voice = new NotionVoice({ token: process.env.NOTION_TOKEN });
```

`token` falls back to `NOTION_TOKEN`, so `new NotionVoice()` works when the variable is set.
Through the stock server image, the same voice is one `TUTTI_VOICES` entry:

```json
[{ "voice": "notion", "options": { "token": "ntn_..." } }]
```

## Tools (8)

| Tool | Destructive | What it does |
|---|---|---|
| `search` | no | Pages and databases shared with the integration whose title matches a query, optionally only pages or only databases. |
| `get_page` | no | A page's title, link, dates, parent and every property as text. |
| `get_page_body` | no | A page's body as markdown-like text, paging through up to `max_blocks` top-level blocks (default 300, at most 1,000). |
| `query_database` | no | A database's rows, with an optional Notion filter object and sorts. |
| `create_page` | **yes** | A new page under a page, or a new row in a database, with a title, optional database properties and optional body. |
| `append_to_page` | **yes** | Text added to the end of a page, converted to blocks. |
| `update_page` | **yes** | New values for some of a page's properties. |
| `archive_page` | **yes** | The page, and everything nested under it, moved to Notion's Trash. |

Every tool that writes is `destructive`, as Slack's posts and Stripe's creates are, so each one
waits for human approval by default: `create_page` and `append_to_page` add content people will
see, `update_page` overwrites the properties it names, and `archive_page` moves a page to the
Trash. The four reads never wait.

Every id accepts 32 hex characters with or without dashes, or a `notion.so` or `notion.site` link
ending in one. Anything else is refused before a request is made.

### Text in and out

`create_page` and `append_to_page` take markdown and turn it into Notion blocks:

| Write | Becomes |
|---|---|
| `#`, `##`, `###` | Headings |
| `- item`, `1. item`, `- [ ] task`, `- [x] done` | Bulleted, numbered and to-do items |
| An item indented two or more spaces under another | A nested item, one level deep |
| `**bold**`, `*italic*` or `_italic_`, `~~strike~~`, `` `code` ``, `[label](https://...)` | Bold, italic, strikethrough, inline code and links, in any block's text |
| `\| a \| b \|`, then `\|---\|---\|`, then rows | A table with a header row |
| `> text` on one or more lines | One quote |
| `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`, then `> text` | A callout with a matching icon and colour |
| ```` ```lang ```` fences | A code block; ```` ```mermaid ```` draws a diagram |
| `![caption](https://...)` alone on a line | An image |
| An `https://` URL alone on a line | A bookmark |
| `---` | A divider |

Anything else is a paragraph. A marker that never closes, such as a lone `**`, stays as literal
text, and a backslash makes the next marker character literal. Table rows shorter than the header
are padded with empty cells and longer ones cut. A table over Notion's 100-row limit is split into
several tables of at most 99 rows each, each repeating the header, rather than refused.

Images and bookmarks are fetched by Notion's own servers, so their URL must be `https://` and
name a public host: `localhost`, loopback, private, link-local and carrier-grade NAT addresses are
refused, and the line stays a paragraph. Links take `http://` or `https://` under the same host
rule; any other link stays as written. The host is checked as written, not resolved.

Notion takes at most 100 top-level blocks per request, so longer content is refused with a hint
to split it and send the rest with `append_to_page`.

`get_page_body` writes the same syntax back: headings, lists, to-dos, quotes, callouts (as
`> [!NOTE]` alerts, the kind read from the icon), code, dividers, images, bookmarks and tables,
with bold, italic, strikethrough, code and links kept. So an agent can read one page and write
its content into another without losing the formatting. It reads one level of children for up to
20 tables, list items and toggles per call, so a table's rows (up to 1,000) and a list's nested
items appear in place. Any other nested content, and anything past those limits, is pointed at
with the id to read it by. Other block types are named in brackets.

## Errors

Every failure comes back as a tool error with the fix, never a throw. A 404 or `object_not_found`
says the page must be shared with the integration through its **Connections** menu. The token is
sent only to `api.notion.com`, never follows a redirect, and is scrubbed from anything Notion
sends back.

## Links

- [Tutti](https://tutti-ai.com)
- [GitHub](https://github.com/tuttiai/tutti/tree/main/voices/notion)
- [Notion API](https://developers.notion.com/reference/intro)

## License

Apache 2.0
