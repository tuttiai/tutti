import type {
  AnthropicEmbeddingConfig,
  EmbeddingProvider,
} from "./types.js";
import {
  EmbeddingRequestError,
  batch,
  normalize,
  withRetry,
} from "./utils.js";

const DEFAULT_MODEL = "voyage-3-lite";
const DEFAULT_BASE_URL = "https://api.voyageai.com/v1";
const DEFAULT_DIMENSIONS = 512; // voyage-3-lite
// Voyage API caps requests at 128 texts.
const MAX_BATCH = 128;

interface VoyageEmbeddingResponse {
  data: { embedding: number[]; index: number }[];
  model: string;
}

/**
 * Embedding provider for Voyage AI models (default: voyage-3-lite).
 *
 * Voyage AI is owned by Anthropic, hence the "anthropic" provider
 * discriminator — but the wire API is Voyage's own, not the Anthropic
 * Messages API.
 */
export class AnthropicEmbeddingProvider implements EmbeddingProvider {
  public readonly name = "anthropic";
  public readonly dimensions: number;

  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly maxBatch: number;
  private readonly maxRetries: number | undefined;

  constructor(config: AnthropicEmbeddingConfig) {
    if (!config.api_key) {
      throw new Error("AnthropicEmbeddingProvider: api_key is required");
    }
    this.apiKey = config.api_key;
    this.model = config.model ?? DEFAULT_MODEL;
    this.baseUrl = config.base_url ?? DEFAULT_BASE_URL;
    this.maxBatch = Math.min(config.max_batch_size ?? MAX_BATCH, MAX_BATCH);
    this.maxRetries = config.max_retries;
    this.dimensions = DEFAULT_DIMENSIONS;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const batches = batch(texts, this.maxBatch);
    const results: number[][] = [];
    for (const group of batches) {
      const vectors = await withRetry(
        () => this.embedBatch(group),
        this.maxRetries,
      );
      for (const v of vectors) results.push(normalize(v));
    }
    return results;
  }

  private async embedBatch(inputs: string[]): Promise<number[][]> {
    const response = await fetch(this.baseUrl + "/embeddings", {
      method: "POST",
      headers: {
        authorization: "Bearer " + this.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: this.model, input: inputs }),
    });

    if (!response.ok) {
      const body = await safeText(response);
      throw new EmbeddingRequestError(
        "Voyage embeddings request failed: " + body.slice(0, 200),
        response.status,
      );
    }

    const json = (await response.json()) as VoyageEmbeddingResponse;
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "(no body)";
  }
}
