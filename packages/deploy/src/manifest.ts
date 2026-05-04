import { ScoreLoader, ScoreValidationError } from "@tuttiai/core";
import type { AgentConfig, DeployConfig, ScoreConfig } from "@tuttiai/types";

import {
  DeployConfigSchema,
  __INTERNAL,
  type DeployManifest,
} from "./types.js";

const { SECRET_LIKE_PATTERNS, DEFAULT_SCALE, DEFAULT_HEALTH } = __INTERNAL;

/**
 * Locate the single agent in the score that declares a `deploy` config.
 *
 * Scoring multiple deployable agents per score isn't supported yet —
 * deployments are intentionally one-per-call so a future `--agent` selector
 * can be the explicit way to pick one. Returns `[name, agent]`.
 *
 * @throws {ScoreValidationError} when zero or multiple agents declare `deploy`.
 */
function pickDeployableAgent(score: ScoreConfig): [string, AgentConfig] {
  const candidates: Array<[string, AgentConfig]> = [];

  for (const [name, agent] of Object.entries(score.agents)) {
    if (agent.deploy !== undefined) {
      candidates.push([name, agent]);
    }
  }

  if (candidates.length === 0) {
    throw new ScoreValidationError(
      "Score has no deployable agents — add a `deploy` block to one agent in the score.",
    );
  }

  if (candidates.length > 1) {
    const names = candidates.map(([n]) => n).join(", ");
    throw new ScoreValidationError(
      `Score has ${String(candidates.length)} agents with deploy configs (${names}). Only one deployable agent per score is supported.`,
    );
  }

  // Length is 1 here; index access is safe.
  const first = candidates[0];
  if (first === undefined) {
    // Unreachable — kept to satisfy noUncheckedIndexedAccess in dependent
    // tooling without a non-null assertion.
    throw new ScoreValidationError("Internal error: no candidate agent.");
  }
  return first;
}

/**
 * Validate that the declared env vars and secrets are usable as written.
 *
 * The Zod schema already enforces name shape and per-array uniqueness; this
 * adds the cross-field rules a single Zod object cannot express:
 *
 *  - `env` keys and `secrets` entries must be disjoint (otherwise the platform
 *    receives two values for the same name).
 *  - `env` values must not match a known secret-shaped pattern (Anthropic /
 *    OpenAI / GitHub / Google API keys, Bearer tokens) — those belong in
 *    `secrets`, not in plaintext config.
 *
 * @throws {ScoreValidationError} on the first conflict found.
 */
function validateEnvAndSecrets(
  agentName: string,
  config: DeployConfig,
): void {
  const env = config.env ?? {};
  const secrets = config.secrets ?? [];

  const secretSet = new Set(secrets);
  for (const key of Object.keys(env)) {
    if (secretSet.has(key)) {
      throw new ScoreValidationError(
        `agents.${agentName}.deploy: "${key}" is declared as both an env var and a secret — pick one.`,
      );
    }
  }

  for (const [key, value] of Object.entries(env)) {
    for (const pattern of SECRET_LIKE_PATTERNS) {
      if (pattern.test(value)) {
        throw new ScoreValidationError(
          `agents.${agentName}.deploy.env.${key}: value looks like an API key — move it to \`secrets\` and reference it by name.`,
        );
      }
    }
  }
}

/**
 * Inspect every agent's `durable` config and report whether any of them pins
 * the given store. `durable: true` accepts memory defaults so it never
 * triggers postgres/redis dependencies — only the explicit-object form does.
 */
function anyAgentDurableUses(
  score: ScoreConfig,
  store: "postgres" | "redis",
): boolean {
  for (const agent of Object.values(score.agents)) {
    const durable = agent.durable;
    if (typeof durable === "object" && durable.store === store) {
      return true;
    }
  }
  return false;
}

/**
 * Detect which infrastructure services the deployment needs. The score is the
 * only place this is captured, so the manifest snapshots it here rather than
 * forcing bundlers to re-parse the score.
 */
function detectServices(score: ScoreConfig): DeployManifest["services"] {
  return {
    postgres:
      score.memory?.provider === "postgres" ||
      anyAgentDurableUses(score, "postgres"),
    redis:
      score.memory?.provider === "redis" ||
      anyAgentDurableUses(score, "redis"),
  };
}

/**
 * Resolve a validated {@link DeployConfig} into a {@link DeployManifest} by
 * filling in every default. After this, downstream bundlers can rely on every
 * field being present with a usable value.
 */
function resolveManifest(
  agentName: string,
  config: DeployConfig,
  score: ScoreConfig,
): DeployManifest {
  return {
    agent_name: agentName,
    target: config.target,
    name: config.name ?? agentName,
    region: config.region ?? "auto",
    env: config.env ?? {},
    secrets: config.secrets ?? [],
    scale: {
      minInstances: config.scale?.minInstances ?? DEFAULT_SCALE.minInstances,
      maxInstances: config.scale?.maxInstances ?? DEFAULT_SCALE.maxInstances,
      ...(config.scale?.memory !== undefined ? { memory: config.scale.memory } : {}),
    },
    healthCheck: {
      path: config.healthCheck?.path ?? DEFAULT_HEALTH.path,
      intervalSeconds:
        config.healthCheck?.intervalSeconds ?? DEFAULT_HEALTH.intervalSeconds,
    },
    services: detectServices(score),
  };
}

/**
 * Load and validate a Tutti score file, then build a normalised
 * {@link DeployManifest} for the (single) agent that declares a `deploy`
 * block.
 *
 * Validation steps, in order:
 *   1. The score file passes the standard Tutti score validation (delegated
 *      to {@link ScoreLoader.load}).
 *   2. Exactly one agent declares a `deploy` block.
 *   3. That block matches {@link DeployConfigSchema} (target enum, deploy
 *      name shape, env/secret name shape, scale bounds, health-check shape).
 *   4. `env` keys and `secrets` entries are disjoint, and no `env` value
 *      matches a known API-key shape.
 *
 * Defaults applied during resolution: `name` ← agent name, `region` ← `auto`,
 * `env` ← `{}`, `secrets` ← `[]`, `scale.minInstances` ← 0,
 * `scale.maxInstances` ← 3, `healthCheck.path` ← `/health`,
 * `healthCheck.intervalSeconds` ← 30.
 *
 * @param scoreFilePath - Path to the `tutti.score.ts` (or compiled `.mjs`) file.
 * @returns The resolved deploy manifest.
 * @throws {ScoreValidationError} when any of the above validations fails.
 *
 * @example
 * const manifest = await buildDeployManifest("./tutti.score.ts");
 * // manifest.target === "fly"; manifest.name === "my-agent"; ...
 */
export async function buildDeployManifest(
  scoreFilePath: string,
): Promise<DeployManifest> {
  const score = await ScoreLoader.load(scoreFilePath);
  const [agentName, agent] = pickDeployableAgent(score);

  const parsed = DeployConfigSchema.safeParse(agent.deploy);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `  - agents.${agentName}.deploy.${path}: ${issue.message}`;
      })
      .join("\n");
    throw new ScoreValidationError(`Invalid deploy config:\n${issues}`);
  }

  validateEnvAndSecrets(agentName, parsed.data);

  return resolveManifest(agentName, parsed.data, score);
}
