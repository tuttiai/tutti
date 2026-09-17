import { z } from "zod";

/** Fields shared by every embedding provider configuration. */
const EmbeddingBaseFields = {
  model: z.string().min(1).optional().describe("Override the provider's default model."),
  max_batch_size: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Override the internal maximum batch size. Rarely needed."),
};

/**
 * Embedding provider configuration, discriminated on `provider`.
 *
 * The `local` variant carries {@link LocalEmbeddingConfig.allow_private},
 * which disables the SSRF guard for this provider. A builder should treat
 * setting it as a privileged action rather than a checkbox: see the field
 * description, which the manifest carries verbatim.
 */
const EmbeddingConfigSchema = z.discriminatedUnion("provider", [
  z
    .object({
      ...EmbeddingBaseFields,
      provider: z.literal("openai"),
      api_key: z.string().min(1).describe("OpenAI API key. Required."),
      base_url: z.string().url().optional().describe("Override the base URL for OpenAI-compatible endpoints."),
    })
    .strict(),
  z
    .object({
      ...EmbeddingBaseFields,
      provider: z.literal("anthropic"),
      api_key: z.string().min(1).describe("Voyage AI API key. Required."),
      base_url: z
        .string()
        .url()
        .optional()
        .describe("Override the base URL. Defaults to https://api.voyageai.com/v1."),
    })
    .strict(),
  z
    .object({
      // The spread comes first so `model`, which this variant requires, overrides
      // the optional one in EmbeddingBaseFields rather than being replaced by it.
      ...EmbeddingBaseFields,
      provider: z.literal("local"),
      base_url: z.string().url().describe("Base URL of the local server, e.g. http://127.0.0.1:11434. Required."),
      model: z.string().min(1).describe('Model name recognised by the server, e.g. "nomic-embed-text". Required.'),
      allow_private: z
        .boolean()
        .optional()
        .describe(
          "SECURITY. Permits a base_url the SSRF guard would refuse: loopback, private IPv4 ranges and link-local. Defaults to false. This disables the check entirely for this provider, not only for loopback, so the cloud instance metadata endpoint 169.254.169.254 becomes reachable. Set it only when base_url is a constant you control, never when it derives from agent or user input.",
        ),
    })
    .strict(),
]);

/** Vector store configuration, discriminated on `provider`. */
const VectorStoreConfigSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("memory") }).strict(),
  z
    .object({
      provider: z.literal("pgvector"),
      connection_string: z
        .string()
        .min(1)
        .optional()
        .describe("Postgres connection string. Falls back to the RAG_PG_URL environment variable. At least one must be set."),
      table: z.string().min(1).optional().describe("Table name. Defaults to rag_chunks."),
    })
    .strict(),
]);

/**
 * Serialisable configuration for the `rag` voice.
 *
 * The `llm` callback that {@link RagVoice} takes as its second argument is a
 * function and is therefore not expressible in a stored document. `hyde`
 * depends on it, which is why the description says so: setting `hyde` in a
 * document that has no way to supply `llm` is silently inert.
 */
export const RagVoiceConfigSchema = z
  .object({
    collection: z.string().min(1).describe("Identifier for the knowledge collection this voice operates on. Required."),
    embeddings: EmbeddingConfigSchema.optional().describe("Embedding provider configuration."),
    storage: VectorStoreConfigSchema.optional().describe("Vector store configuration."),
    default_top_k: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Default top-K returned by search_knowledge when a call does not specify one."),
    chunk_size: z.number().int().positive().optional().describe("Maximum characters per chunk during ingestion."),
    chunk_overlap: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Overlapping characters between adjacent chunks."),
    hyde: z
      .boolean()
      .optional()
      .describe(
        "Enable HyDE query rewriting for search_knowledge. Requires an llm callback passed to RagVoice in code, and is ignored otherwise, so it has no effect when set from a stored document alone.",
      ),
  })
  .strict();

/** Serialisable configuration for the `rag` voice. */
export type RagVoiceConfig = z.infer<typeof RagVoiceConfigSchema>;
