# @tuttiai/knowledge

Read-only search over knowledge bases that a separate service holds for the agent. The service
ingests, chunks, embeds, stores and decides which bases this agent may read; the voice only lists
and searches them.

Reach for [`@tuttiai/rag`](../rag) instead when the agent should ingest and store documents in its
own process. Reach for this voice when documents are managed somewhere else, by people, and the
agent must see only the bases it was given.

## Install

```bash
npm install @tuttiai/knowledge
```

## Quickstart

```ts
import { KnowledgeVoice } from "@tuttiai/knowledge";

const voice = new KnowledgeVoice({
  url: "https://kb.example.com/agents/support-lead",
  token: process.env.KNOWLEDGE_TOKEN!,
});
```

Through the stock server image, the same voice is one `TUTTI_VOICES` entry:

```json
[{ "voice": "knowledge", "options": { "url": "http://control-plane:4849/agent/v1/…/knowledge", "token": "…" } }]
```

## Tools

| Tool | What it does |
|---|---|
| `list_knowledge_bases` | The bases this agent may search, with a description and how many sources and passages each holds. |
| `search_knowledge_bases` | The passages most relevant to a query, each naming its base, source and location. `bases` narrows it to some of the agent's bases. |

Neither tool changes anything, so neither is `destructive`.

## Configuration

| Option | Required | Meaning |
|---|---|---|
| `url` | yes | The service's address for this agent. `http` or `https` only. |
| `token` | yes | Bearer token the service identifies the agent by. |
| `default_top_k` | no | Passages returned when the model does not say, 1 to 20. Default 5. |
| `timeout_ms` | no | How long one call may take, 1,000 to 60,000. Default 15,000. |

**`url` carries no host policy**, unlike a URL a tool is handed. The service usually sits on the
deployer's own private network, and no tool takes an address, so the model cannot point the
voice anywhere else. Set it from the code that deploys the agent, never from agent or user input.

The token is sent only to `url`, never follows a redirect (`redirect: "error"`), and is scrubbed
from any refusal sentence the service sends back.

## The service protocol

Any service answering these two calls works. Both carry `Authorization: Bearer <token>`.

```
GET  <url>/bases   →  { "bases": [{ "handle", "name", "description", "sources", "chunks" }] }
POST <url>/search  ←  { "query", "top_k", "bases"? }
                   →  { "results": [{ "base", "source", "title", "text", "score", "location" }],
                        "mode": "hybrid" | "keyword", "searched": ["handle", …] }
```

A refusal is any non-2xx answer, ideally `{ "error", "message" }`; the `message` is passed to the
model, shortened to 300 characters. The service, not the voice, decides what the agent may read:
a base it withholds is absent from both answers. Unknown fields are ignored. The schemas are
exported as `ListBasesResponseSchema`, `SearchRequestSchema` and `SearchResponseSchema`.

## Links

- [Tutti](https://tutti-ai.com)
- [GitHub](https://github.com/tuttiai/tutti/tree/main/voices/knowledge)

## License

Apache 2.0
