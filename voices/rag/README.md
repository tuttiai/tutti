# @tuttiai/rag

Retrieval-augmented generation for [Tutti](https://tutti-ai.com) — ingest documents into a knowledge base, then let agents query it through embeddings + BM25.

## Install

```bash
npm install @tuttiai/rag
```

## Quickstart

Wire the voice into a score with an embedding provider and a vector store:

```ts
import { TuttiRuntime, AnthropicProvider, defineScore } from "@tuttiai/core";
import { RagVoice } from "@tuttiai/rag";

const score = defineScore({
  provider: new AnthropicProvider(),
  agents: {
    researcher: {
      name: "researcher",
      model: "claude-sonnet-4-20250514",
      system_prompt:
        "You are a research assistant. Ingest sources with ingest_document, " +
        "then answer questions using search_knowledge.",
      voices: [
        RagVoice({
          collection: "product-docs",
          embeddings: {
            provider: "openai",
            api_key: process.env.OPENAI_API_KEY!,
          },
          storage: { provider: "memory" },
        }),
      ],
      permissions: ["network"],
    },
  },
});

const tutti = new TuttiRuntime(score);
await tutti.run("researcher", "Ingest ./docs/pricing.md then summarise it.");
```

## Tools

| Tool | Description |
|---|---|
| `ingest_document` | Load a document from a path, URL, or GitHub blob URL; chunk, embed, and store it. |
| `search_knowledge` | Return top-K chunks relevant to a query. Supports optional hybrid (BM25 + vector) fusion. |
| `list_sources` | Enumerate every ingested source with chunk count and ingest timestamp. |
| `delete_source` | Drop every chunk for a `source_id` from both the vector store and the keyword index. |

All tool results are JSON-encoded strings so downstream agents can parse them directly.

## Configuration

`RagVoice(config, options?)` accepts:

```ts
interface RagConfig {
  collection: string;                    // logical name for this knowledge base
  embeddings?: EmbeddingConfig;          // required — see below
  storage?: VectorStoreConfig;           // defaults to in-memory
  default_top_k?: number;                // default 5
  hyde?: boolean;                        // requires options.llm
}

interface RagVoiceOptions {
  llm?: (prompt: string) => Promise<string>;
}
```

### Embedding providers

```ts
// OpenAI — text-embedding-3-small, batches up to 2048.
embeddings: { provider: "openai", api_key: process.env.OPENAI_API_KEY! }

// Voyage AI (via Anthropic-owned Voyage API) — voyage-3-lite.
embeddings: { provider: "anthropic", api_key: process.env.VOYAGE_API_KEY! }

// Ollama-compatible local server — any model that supports /api/embeddings.
embeddings: {
  provider: "local",
  base_url: "http://127.0.0.1:11434",
  model: "nomic-embed-text",
  allow_private: true,  // opt in to loopback / private IPs
}
```

Every provider retries on rate-limit errors with exponential backoff (3 attempts, 500/1000/2000 ms) and returns L2-normalised vectors so cosine reduces to a dot product at query time.

### Vector stores

```ts
// In-memory brute-force cosine — good up to ~100k chunks.
storage: { provider: "memory" }

// pgvector. Connection string from config or SecretsManager("RAG_PG_URL").
storage: {
  provider: "pgvector",
  connection_string: "postgres://user:pass@host/db",
  table: "rag_chunks",  // optional, default "rag_chunks"
}
```

On first use, `PgVectorStore` runs `CREATE EXTENSION IF NOT EXISTS vector` and creates the chunk table + source index (idempotent).

### HyDE (optional)

Set `config.hyde: true` and pass an `llm` callback to have `search_knowledge` first generate a hypothetical answer paragraph via the LLM and embed that instead of the raw query:

```ts
RagVoice(
  { collection: "docs", embeddings: { ... }, hyde: true },
  {
    llm: async (prompt) => {
      const res = await myLlmProvider.chat({ messages: [{ role: "user", content: prompt }] });
      return res.text;
    },
  },
);
```

### Hybrid search

Callers can enable hybrid retrieval per-query by passing `hybrid: true` to `search_knowledge`. Results are fused using Reciprocal Rank Fusion (k = 60) over the semantic and BM25 rankings, de-duplicated by chunk ID.

## Ingestion details

- **Formats**: plain text, Markdown (frontmatter stripped, formatting flattened via `remark`), PDF (`pdf-parse`).
- **Sources**: local paths, HTTP(S) URLs (SSRF-guarded), and GitHub blob URLs (rewritten to `raw.githubusercontent.com`).
- **Chunking**: `ChunkStrategy.Fixed` (default, 512 whitespace tokens with 20% overlap), `Sentence`, or `Paragraph` — select via the `strategy` argument on `ingest_document`.

## Advanced: low-level building blocks

The voice is a thin wrapper over primitives you can also use directly:

```ts
import {
  ingestDocument,
  createEmbeddingProvider,
  createVectorStore,
  SearchEngine,
  ChunkStrategy,
} from "@tuttiai/rag";

const embeddings = createEmbeddingProvider({
  collection: "x",
  embeddings: { provider: "openai", api_key: process.env.OPENAI_API_KEY! },
});
const store = createVectorStore({ collection: "x" });
const engine = new SearchEngine({ embeddings, store });

const chunks = await ingestDocument(
  { source_id: "readme", path: "./README.md" },
  { strategy: ChunkStrategy.Paragraph },
);
const vectors = await embeddings.embed(chunks.map((c) => c.text));
const embedded = chunks.map((c, i) => ({
  ...c,
  vector: vectors[i]!,
  chunk_id: "readme:" + c.chunk_index,
}));
await store.upsert(embedded);
engine.index(embedded);

const hits = await engine.search("how do I install this", { topK: 3 });
```

## Caveats

- The BM25 keyword index lives in memory; it is rebuilt from scratch on the next search after any write and is not persisted across restarts. For long-running services with a pgvector backend, re-ingesting (or calling `engine.index(...)` with stored chunks) on startup is the workaround until a `VectorStore.scan()` surface exists.
- `pdf-parse` 2.x bundles `pdfjs-dist`; expect the first PDF ingest to take a second or two while the worker boots.

## Links

- [Tutti](https://tutti-ai.com)
- [GitHub](https://github.com/tuttiai/tutti/tree/main/voices/rag)
- [Voice Registry](https://tutti-ai.com/voices)

## License

Apache 2.0
