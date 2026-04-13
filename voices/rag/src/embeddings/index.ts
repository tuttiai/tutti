import type { RagConfig } from "../types.js";
import { AnthropicEmbeddingProvider } from "./anthropic.js";
import { LocalEmbeddingProvider } from "./local.js";
import { OpenAIEmbeddingProvider } from "./openai.js";
import type { EmbeddingConfig, EmbeddingProvider } from "./types.js";

export type {
  EmbeddingProvider,
  EmbeddingConfig,
  OpenAIEmbeddingConfig,
  AnthropicEmbeddingConfig,
  LocalEmbeddingConfig,
} from "./types.js";
export { OpenAIEmbeddingProvider } from "./openai.js";
export { AnthropicEmbeddingProvider } from "./anthropic.js";
export { LocalEmbeddingProvider } from "./local.js";
export { EmbeddingRequestError } from "./utils.js";

/**
 * Construct an {@link EmbeddingProvider} from a {@link RagConfig}.
 *
 * The provider is selected via `config.embeddings.provider`:
 * - `"openai"` → {@link OpenAIEmbeddingProvider}
 * - `"anthropic"` → {@link AnthropicEmbeddingProvider} (Voyage AI backend)
 * - `"local"` → {@link LocalEmbeddingProvider} (Ollama-compatible)
 *
 * @throws When `config.embeddings` is missing or the provider discriminator
 *         is unknown.
 */
export function createEmbeddingProvider(config: RagConfig): EmbeddingProvider {
  const embed = config.embeddings;
  if (!embed) {
    throw new Error(
      "createEmbeddingProvider: RagConfig.embeddings is required",
    );
  }
  return dispatch(embed);
}

function dispatch(config: EmbeddingConfig): EmbeddingProvider {
  switch (config.provider) {
    case "openai":
      return new OpenAIEmbeddingProvider(config);
    case "anthropic":
      return new AnthropicEmbeddingProvider(config);
    case "local":
      return new LocalEmbeddingProvider(config);
    default: {
      // Runtime guard — TS exhaustiveness doesn't catch values smuggled in
      // via `as unknown`. Surface a loud error instead of silently returning
      // undefined.
      const unknownProvider = (config as { provider: string }).provider;
      throw new Error(
        "createEmbeddingProvider: unknown provider '" + unknownProvider + "'",
      );
    }
  }
}
