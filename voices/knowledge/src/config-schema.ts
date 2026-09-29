import { z } from "zod";

/**
 * Serialisable configuration for the `knowledge` voice.
 *
 * `url` and `token` are set by whoever deploys the agent, never by the model: no tool takes an
 * address. That is why `url` carries no host policy, unlike a URL a tool is handed. The service
 * usually sits on the deployer's own private network, which a host policy would refuse, and
 * the address is a constant that deployer chose.
 */
export const KnowledgeVoiceConfigSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine((value) => /^https?:\/\//i.test(value), "knowledge: url must be an http or https address")
      .describe(
        "The knowledge service's address for this agent. GET <url>/bases and POST <url>/search are called under it.",
      ),
    token: z
      .string()
      .min(1)
      .describe("Bearer token the service identifies this agent by. Never sent anywhere but url."),
    default_top_k: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("How many passages a search returns when the model does not say. Default 5."),
    timeout_ms: z
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .optional()
      .describe("How long one call to the service may take. Default 15000."),
  })
  .strict();

/** Serialisable configuration for the `knowledge` voice. */
export type KnowledgeVoiceConfig = z.infer<typeof KnowledgeVoiceConfigSchema>;
