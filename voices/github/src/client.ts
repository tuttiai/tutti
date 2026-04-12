import { Octokit } from "@octokit/rest";
import { SecretsManager } from "@tuttiai/core";
import { logger } from "./logger.js";

let warned = false;

export function createOctokit(token?: string): Octokit {
  const auth = token ?? SecretsManager.optional("GITHUB_TOKEN");

  if (!auth && !warned) {
    warned = true;
    logger.warn("No GITHUB_TOKEN set — requests will be unauthenticated (60 req/hr rate limit)");
  }

  return new Octokit({ auth: auth || undefined });
}
