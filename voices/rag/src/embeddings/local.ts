import type { EmbeddingProvider, LocalEmbeddingConfig } from "./types.js";
import { assertSafeUrl } from "../utils/url-guard.js";
import {
  EmbeddingRequestError,
  batch,
  normalize,
  withRetry,
} from "./utils.js";

// Ollama's /api/embeddings takes ONE prompt per request. We "batch" only to
// keep retry/normalise logic consistent — each item is still one HTTP call.
const DEFAULT_MAX_BATCH = 16;

interface OllamaEmbeddingResponse {
  embedding: number[];
}

/**
 * Local embeddings provider targeting Ollama-compatible servers
 * (`POST /api/embeddings`, `{ model, prompt } → { embedding: number[] }`).
 *
 * The first successful response seeds {@link dimensions} — before that it
 * reports `0` so callers know the shape isn't yet known. Dimensions for
 * local models vary (e.g. nomic-embed-text = 768, mxbai-embed-large = 1024).
 *
 * NOTE: `base_url` is validated with the voice's SSRF guard, which means
 * localhost / private IPs are rejected. When actually running Ollama on
 * localhost, the caller must opt in explicitly — see `allow_private`.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  public readonly name = "local";
  public dimensions = 0;

  private readonly baseUrl: string;
  private readonly model: string;
  private readonly maxBatch: number;
  private readonly maxRetries: number | undefined;

  constructor(config: LocalEmbeddingConfig & { allow_private?: boolean }) {
    if (!config.base_url) {
      throw new Error("LocalEmbeddingProvider: base_url is required");
    }
    if (!config.allow_private) {
      // Enforce the voice-wide URL policy unless the caller opts out.
      assertSafeUrl(config.base_url);
    }
    this.baseUrl = config.base_url.replace(/\/$/, "");
    this.model = config.model;
    this.maxBatch = config.max_batch_size ?? DEFAULT_MAX_BATCH;
    this.maxRetries = config.max_retries;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const batches = batch(texts, this.maxBatch);
    const results: number[][] = [];
    for (const group of batches) {
      for (const text of group) {
        const vec = await withRetry(
          () => this.embedOne(text),
          this.maxRetries,
        );
        if (this.dimensions === 0) this.dimensions = vec.length;
        results.push(normalize(vec));
      }
    }
    return results;
  }

  private async embedOne(text: string): Promise<number[]> {
    const response = await fetch(this.baseUrl + "/api/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });

    if (!response.ok) {
      const body = await safeText(response);
      throw new EmbeddingRequestError(
        "Local embeddings request failed: " + body.slice(0, 200),
        response.status,
      );
    }

    const json = (await response.json()) as OllamaEmbeddingResponse;
    if (!Array.isArray(json.embedding) || json.embedding.length === 0) {
      throw new EmbeddingRequestError(
        "Local embeddings response missing `embedding` array",
      );
    }
    return json.embedding;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "(no body)";
  }
}
