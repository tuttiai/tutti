/**
 * Embedding provider contract.
 *
 * Implementations MUST:
 * - honour their backend's batch-size limits internally (callers shouldn't
 *   have to know the limits)
 * - retry on rate-limit errors with exponential backoff
 * - return L2-normalised (unit-length) vectors
 * - return one vector per input, in the same order
 */
export interface EmbeddingProvider {
  /** Stable identifier used for logging and cache keys. */
  readonly name: string;
  /** Vector dimensionality — consistent across every call. */
  readonly dimensions: number;
  /** Embed `texts` and return one unit vector per input. */
  embed(texts: string[]): Promise<number[][]>;
}

/** Common fields shared by all provider configurations. */
interface EmbeddingConfigBase {
  /** Override the default model for the provider. */
  model?: string;
  /** Override internal max batch size. Rarely needed. */
  max_batch_size?: number;
  /** Max retry attempts on rate-limit / transient errors. Default 3. */
  max_retries?: number;
}

/** Configuration for {@link createEmbeddingProvider} when targeting OpenAI. */
export interface OpenAIEmbeddingConfig extends EmbeddingConfigBase {
  provider: "openai";
  /** API key. Required. Pass from your score file (e.g. via env). */
  api_key: string;
  /** Override base URL for OpenAI-compatible endpoints. */
  base_url?: string;
}

/**
 * Configuration for voyage-3-lite and other Voyage AI embedding models.
 *
 * Labelled `anthropic` for parity with Tutti's provider naming — Voyage AI
 * is owned by Anthropic, even though it has a separate API surface.
 */
export interface AnthropicEmbeddingConfig extends EmbeddingConfigBase {
  provider: "anthropic";
  /** Voyage AI API key. Required. */
  api_key: string;
  /** Override base URL. Default: https://api.voyageai.com/v1 */
  base_url?: string;
}

/** Configuration for an Ollama-compatible local embeddings server. */
export interface LocalEmbeddingConfig extends EmbeddingConfigBase {
  provider: "local";
  /** Base URL of the local server, e.g. http://127.0.0.1:11434 */
  base_url: string;
  /** Model name recognised by the server, e.g. "nomic-embed-text". */
  model: string;
  /**
   * Permit a `base_url` that the SSRF guard would otherwise refuse: loopback
   * hosts (`localhost`, `127.0.0.1`, `::1`), the private IPv4 ranges
   * (10/8, 172.16/12, 192.168/16) and link-local (169.254/16).
   *
   * Defaults to `false`, so a local embeddings server on `localhost` is
   * rejected until this is set. That default is deliberate: it is the same
   * guard every other remote fetch in this voice runs, and it exists because
   * ingested content can influence what an agent asks for.
   *
   * **What you give up.** This disables the check entirely for this provider,
   * not just for loopback. `169.254.169.254` — the cloud instance metadata
   * endpoint — becomes reachable too. Only set it when `base_url` is a
   * constant you control, never when it derives from agent or user input.
   *
   * @default false
   */
  allow_private?: boolean;
}

/** Discriminated union of every supported embedding provider configuration. */
export type EmbeddingConfig =
  | OpenAIEmbeddingConfig
  | AnthropicEmbeddingConfig
  | LocalEmbeddingConfig;
