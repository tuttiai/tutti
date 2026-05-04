/**
 * `@tuttiai/deploy` — bundles a Tutti score as a deployable artefact for
 * Docker, Cloudflare Workers, Railway, or Fly.
 *
 * Public surface:
 *  - `DeployConfig` / `DeployConfigSchema` — the per-agent deploy block.
 *  - `DeployManifest` — resolved, validated, defaults-applied deployment
 *    description that bundlers consume.
 *  - `buildDeployManifest(scoreFilePath)` — load a score and produce a
 *    manifest for its single deployable agent.
 */

export {
  DEPLOY_TARGETS,
  DeployConfigSchema,
  type DeployConfig,
  type DeployManifest,
} from "./types.js";
export { buildDeployManifest } from "./manifest.js";
export {
  generateDockerBundle,
  buildDockerfile,
  buildDockerignore,
  buildDockerCompose,
  buildDeployScript,
} from "./targets/docker.js";
export {
  generateFlyConfig,
  buildFlyConfig,
} from "./targets/fly.js";
export {
  scanForSecrets,
  validateSecrets,
  buildEnvExample,
  type SecretsValidationResult,
} from "./secrets.js";
