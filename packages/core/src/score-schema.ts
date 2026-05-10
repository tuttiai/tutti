import { z } from "zod";
import { ScoreValidationError } from "./errors.js";

/**
 * Runtime Zod schema for validating a loaded ScoreConfig object.
 *
 * Since score files export instantiated classes (providers, voices),
 * we validate structural shape rather than literal types.
 */

const PermissionSchema = z.enum(["network", "filesystem", "shell", "browser"]);

const VoiceSchema = z
  .object({
    name: z.string().min(1, "Voice name cannot be empty"),
    tools: z.array(z.any()),
    required_permissions: z.array(PermissionSchema),
  })
  .passthrough();

const BudgetSchema = z
  .object({
    max_tokens: z.number().positive().optional(),
    max_cost_usd: z.number().positive().optional(),
    warn_at_percent: z.number().min(1).max(100).optional(),
  })
  .strict();

const CacheSchema = z
  .object({
    enabled: z.boolean(),
    ttl_ms: z.number().int().positive("cache.ttl_ms must be a positive number").optional(),
    excluded_tools: z.array(z.string()).optional(),
  })
  .strict();

const AgentSchema = z
  .object({
    name: z.string().min(1, "Agent name cannot be empty"),
    system_prompt: z.string().min(1, "Agent system_prompt cannot be empty"),
    voices: z.array(VoiceSchema),
    model: z.string().optional(),
    description: z.string().optional(),
    permissions: z.array(PermissionSchema).optional(),
    max_turns: z.number().int().positive("max_turns must be a positive number").optional(),
    max_tool_calls: z.number().int().positive("max_tool_calls must be a positive number").optional(),
    tool_timeout_ms: z.number().int().positive("tool_timeout_ms must be a positive number").optional(),
    budget: BudgetSchema.optional(),
    streaming: z.boolean().optional(),
    allow_human_input: z.boolean().optional(),
    delegates: z.array(z.string()).optional(),
    role: z.enum(["orchestrator", "specialist"]).optional(),
    cache: CacheSchema.optional(),
  })
  .passthrough();

const TelemetrySchema = z
  .object({
    enabled: z.boolean(),
    endpoint: z.string().url("telemetry.endpoint must be a valid URL").optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const InboxPlatformSchema = z.enum(["telegram", "slack", "discord", "email", "whatsapp"]);

const ImapConfigSchema = z
  .object({
    host: z.string().min(1, "imap.host is required"),
    port: z.number().int().min(1).max(65535),
    user: z.string().min(1, "imap.user is required"),
    secure: z.boolean().optional(),
  })
  .strict();

const SmtpConfigSchema = z
  .object({
    host: z.string().min(1, "smtp.host is required"),
    port: z.number().int().min(1).max(65535),
    user: z.string().min(1, "smtp.user is required"),
    secure: z.boolean().optional(),
  })
  .strict();

const InboxAdapterSchema = z.discriminatedUnion("platform", [
  z
    .object({
      platform: z.literal("telegram"),
      token: z.string().min(1).optional(),
      polling: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      platform: z.literal("slack"),
      botToken: z.string().min(1).optional(),
      appToken: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      platform: z.literal("discord"),
      token: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      platform: z.literal("email"),
      imap: ImapConfigSchema,
      smtp: SmtpConfigSchema,
      from: z.string().min(1, "email.from is required"),
      maxBodyChars: z.number().int().positive().optional(),
      inboxRedactRawText: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      platform: z.literal("whatsapp"),
      phoneNumberId: z.string().min(1, "whatsapp.phoneNumberId is required"),
      port: z.number().int().min(1).max(65535).optional(),
      host: z.string().min(1).optional(),
      graphApiVersion: z.string().regex(/^v\d+\.\d+$/, "graphApiVersion must look like 'v21.0'").optional(),
      bodyLimit: z.number().int().positive().optional(),
      inboxRedactRawText: z.boolean().optional(),
    })
    .strict(),
]);

const InboxRateLimitSchema = z.union([
  z.object({ disabled: z.literal(true) }).strict(),
  z
    .object({
      messagesPerWindow: z
        .number()
        .int()
        .positive("inbox.rateLimit.messagesPerWindow must be a positive integer"),
      windowMs: z
        .number()
        .int()
        .positive("inbox.rateLimit.windowMs must be a positive integer"),
      burst: z
        .number()
        .int()
        .positive("inbox.rateLimit.burst must be a positive integer")
        .optional(),
    })
    .strict(),
]);

const InboxSchema = z
  .object({
    agent: z.string().min(1, "inbox.agent must be a non-empty agent id"),
    adapters: z
      .array(InboxAdapterSchema)
      .min(1, "inbox.adapters must declare at least one adapter"),
    allowedUsers: z.record(InboxPlatformSchema, z.array(z.string())).optional(),
    rateLimit: InboxRateLimitSchema.optional(),
    maxQueuePerChat: z
      .number()
      .int()
      .positive("inbox.maxQueuePerChat must be a positive integer")
      .optional(),
  })
  .strict();

const ParallelEntrySchema = z
  .object({
    type: z.literal("parallel"),
    agents: z
      .array(z.string())
      .min(1, "Parallel entry requires at least one agent"),
  })
  .strict();

const EntrySchema = z.union([z.string(), ParallelEntrySchema]);

const ScoreSchema = z
  .object({
    provider: z
      .object({ chat: z.function() })
      .passthrough()
      .refine((p) => typeof p.chat === "function", {
        message: "provider must have a chat() method — did you forget to pass a provider instance?",
      }),
    agents: z.record(z.string(), AgentSchema).refine(
      (agents) => Object.keys(agents).length > 0,
      { message: "Score must define at least one agent" },
    ),
    name: z.string().optional(),
    description: z.string().optional(),
    default_model: z.string().optional(),
    entry: EntrySchema.optional(),
    telemetry: TelemetrySchema.optional(),
    inbox: InboxSchema.optional(),
  })
  .passthrough();

/**
 * Validate a loaded score config. Returns the config on success,
 * throws a descriptive error on failure.
 */
export function validateScore(config: unknown): void {
  const result = ScoreSchema.safeParse(config);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${path}: ${issue.message}`;
    });
    throw new ScoreValidationError(
      "Invalid score file:\n" + issues.join("\n"),
    );
  }

  // Cross-field validation: delegates must reference existing agent keys
  const data = result.data;
  const agentKeys = Object.keys(data.agents);

  for (const [key, agent] of Object.entries(data.agents)) {
    if (agent.delegates) {
      for (const delegateId of agent.delegates) {
        if (!agentKeys.includes(delegateId)) {
          throw new ScoreValidationError(
            `Invalid score file:\n  - agents.${key}.delegates: references unknown agent "${delegateId}". Available: ${agentKeys.join(", ")}`,
            { field: `agents.${key}.delegates`, value: delegateId },
          );
        }
      }
    }
  }

  // Cross-field: entry must reference existing agent(s)
  if (data.entry) {
    if (typeof data.entry === "string") {
      if (!agentKeys.includes(data.entry)) {
        throw new ScoreValidationError(
          `Invalid score file:\n  - entry: references unknown agent "${data.entry}". Available: ${agentKeys.join(", ")}`,
          { field: "entry", value: data.entry },
        );
      }
    } else {
      // Parallel entry
      for (const id of data.entry.agents) {
        if (!agentKeys.includes(id)) {
          throw new ScoreValidationError(
            `Invalid score file:\n  - entry.agents: references unknown agent "${id}". Available: ${agentKeys.join(", ")}`,
            { field: "entry.agents", value: id },
          );
        }
      }
    }
  }
}
