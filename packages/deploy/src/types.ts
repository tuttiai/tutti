import { z } from "zod";

/**
 * Targets supported by `@tuttiai/deploy`. Each target has its own bundler that
 * consumes the {@link DeployManifest} produced by {@link buildDeployManifest}.
 *
 * - `docker`     — emit a Dockerfile + image build context.
 * - `cloudflare` — emit a Cloudflare Worker bundle (wrangler-compatible).
 * - `railway`    — emit a Railway service config (`railway.json`).
 * - `fly`        — emit a Fly Machine config (`fly.toml`).
 */
export const DEPLOY_TARGETS = ["docker", "cloudflare", "railway", "fly"] as const;

const DeployTargetSchema = z.enum(DEPLOY_TARGETS);

/**
 * Deployment names are used as container, worker, app, or service identifiers
 * across every target. The intersection of the platforms' rules: lowercase
 * alphanumerics and hyphens, must start and end with an alphanumeric, 1–63
 * characters long.
 *
 * Implemented as a Zod refinement using simple character-class checks rather
 * than one regex with overlapping character classes — keeps the validator
 * trivially linear (no backtracking surface) and explicit about each rule.
 */
const NAME_CHARSET = /^[a-z0-9-]+$/;
const NAME_ALNUM = /^[a-z0-9]$/;
function isValidDeployName(s: string): boolean {
  if (s.length === 0 || s.length > 63) return false;
  if (!NAME_CHARSET.test(s)) return false;
  const first = s.charAt(0);
  const last = s.charAt(s.length - 1);
  return NAME_ALNUM.test(first) && NAME_ALNUM.test(last);
}

/**
 * Env var and secret names follow the POSIX-style convention used elsewhere in
 * Tutti — uppercase letter or underscore first, then uppercase letters, digits,
 * or underscores.
 */
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Heuristic patterns that indicate a value is almost certainly a secret. Used
 * by {@link buildDeployManifest} to refuse storing it in `env` (where it would
 * end up in plaintext config) and force callers to declare it in `secrets`.
 *
 * Mirrors the redaction patterns in `SecretsManager` so the two stay aligned.
 */
const SECRET_LIKE_PATTERNS: readonly RegExp[] = [
  /sk-ant-[a-zA-Z0-9-_]{20,}/, // Anthropic
  /sk-[a-zA-Z0-9]{20,}/, // OpenAI
  /ghp_[a-zA-Z0-9]{36}/, // GitHub PAT
  /AIza[a-zA-Z0-9-_]{35}/, // Google API key
  /^Bearer [a-zA-Z0-9-_.]{20,}$/, // Bearer tokens
];

const NameSchema = z
  .string()
  .min(1, "name cannot be empty")
  .max(63, "name cannot be longer than 63 characters")
  .refine(
    isValidDeployName,
    "name must be lowercase alphanumeric with hyphens (e.g. 'my-agent')",
  );

const EnvNameSchema = z
  .string()
  .regex(
    ENV_NAME_PATTERN,
    "env var names must match /^[A-Z_][A-Z0-9_]*$/ (e.g. 'LOG_LEVEL')",
  );

const ScaleSchema = z
  .object({
    minInstances: z
      .number()
      .int("scale.minInstances must be an integer")
      .min(0, "scale.minInstances cannot be negative")
      .default(0),
    maxInstances: z
      .number()
      .int("scale.maxInstances must be an integer")
      .min(1, "scale.maxInstances must be at least 1")
      .default(3),
    memory: z
      .string()
      .regex(
        /^\d+(mb|gb)$/i,
        "scale.memory must look like '512mb' or '1gb'",
      )
      .optional(),
  })
  .strict()
  .refine(
    (s) => s.maxInstances >= s.minInstances,
    {
      message: "scale.maxInstances must be >= scale.minInstances",
      path: ["maxInstances"],
    },
  );

const HealthCheckSchema = z
  .object({
    path: z
      .string()
      .startsWith("/", "healthCheck.path must start with '/'")
      .default("/health"),
    intervalSeconds: z
      .number()
      .int("healthCheck.intervalSeconds must be an integer")
      .positive("healthCheck.intervalSeconds must be positive")
      .default(30),
  })
  .strict();

const DEFAULT_SCALE = { minInstances: 0, maxInstances: 3 } as const;
const DEFAULT_HEALTH = { path: "/health", intervalSeconds: 30 } as const;

/**
 * Zod schema for {@link DeployConfig}. Source of truth for runtime validation
 * of the `deploy` field on an `AgentConfig`.
 */
export const DeployConfigSchema = z
  .object({
    target: DeployTargetSchema,
    name: NameSchema.optional(),
    region: z.string().min(1).optional(),
    env: z.record(EnvNameSchema, z.string()).optional(),
    secrets: z.array(EnvNameSchema).optional(),
    scale: ScaleSchema.optional(),
    healthCheck: HealthCheckSchema.optional(),
  })
  .strict();

/**
 * Configuration block describing how to deploy an agent's Tutti runtime.
 *
 * Attached to an `AgentConfig` via its optional `deploy` field. The
 * {@link buildDeployManifest} function reads this, fills in defaults, and
 * returns a normalised {@link DeployManifest} ready to hand to a bundler.
 */
export type DeployConfig = z.infer<typeof DeployConfigSchema>;

/**
 * Resolved, normalised deployment description. Every default has been applied
 * and every cross-field rule (`maxInstances >= minInstances`, `secrets` and
 * `env` keys disjoint, no plaintext API keys in `env`) has been verified.
 *
 * Bundlers consume this and never the raw {@link DeployConfig}.
 */
export interface DeployManifest {
  /** Agent ID this manifest was built for (key in `score.agents`). */
  agent_name: string;
  target: (typeof DEPLOY_TARGETS)[number];
  /** Resolved deployment name — falls back to the agent name when unset. */
  name: string;
  /** Resolved region — `'auto'` when unset. */
  region: string;
  /** Plaintext env vars. Always present (empty object when none declared). */
  env: Record<string, string>;
  /** Names of secrets to pull from the platform secret store. */
  secrets: string[];
  scale: {
    minInstances: number;
    maxInstances: number;
    memory?: string;
  };
  healthCheck: {
    path: string;
    intervalSeconds: number;
  };
  /**
   * Infrastructure services the bundler should include alongside the agent.
   * Populated by `buildDeployManifest` from the score's `memory.provider`
   * and per-agent `durable` config — the score is the only place this
   * information lives, so bundlers (e.g. docker-compose generation) read it
   * from here rather than re-parsing the score.
   */
  services: {
    postgres: boolean;
    redis: boolean;
  };
}

/**
 * @internal — exposed for tests so they can exercise the same rules the
 * manifest builder uses without re-deriving the regexes.
 */
export const __INTERNAL = {
  isValidDeployName,
  ENV_NAME_PATTERN,
  SECRET_LIKE_PATTERNS,
  DEFAULT_SCALE,
  DEFAULT_HEALTH,
};
