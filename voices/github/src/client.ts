import { Octokit } from "@octokit/rest";

let warned = false;

export function createOctokit(token?: string): Octokit {
  const auth = token ?? process.env.GITHUB_TOKEN;

  if (!auth && !warned) {
    warned = true;
    console.warn(
      "[github voice] No GITHUB_TOKEN set — requests will be unauthenticated (60 req/hr rate limit).",
    );
  }

  return new Octokit({ auth: auth || undefined });
}
