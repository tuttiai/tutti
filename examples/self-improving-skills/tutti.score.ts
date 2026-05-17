/**
 * Self-improving skills — end-to-end demonstration.
 *
 * One agent (`code-reviewer`) reviews pull requests using the GitHub
 * and filesystem voices. After it has reviewed the same shape of PR
 * five times, the trajectory observer feeds the recorded runs to the
 * synthesiser, which proposes a `review_pr` candidate. An operator
 * approves it via `tutti-ai skills review`; from the next run onward
 * the agent calls `review_pr` as a single tool instead of orchestrating
 * the constituents itself.
 *
 * Sanity check (no API key required):
 *
 *   npx tsx examples/self-improving-skills/tutti.score.ts --check
 *
 * Run interactively (requires ANTHROPIC_API_KEY + GITHUB_TOKEN):
 *
 *   tutti-ai run --score examples/self-improving-skills/tutti.score.ts
 *
 * See README.md in this directory for the full walk-through.
 */

import {
  AnthropicProvider,
  InMemorySessionStore,
  SecretsManager,
  defineScore,
} from "@tuttiai/core";
import { InMemorySkillStore } from "@tuttiai/skills";
import { FilesystemVoice } from "@tuttiai/filesystem";
import { GitHubVoice } from "@tuttiai/github";
import type { LLMProvider } from "@tuttiai/types";

/**
 * Resolve the LLM provider. We default to Anthropic but fall back to a
 * trivial stub when no API key is set so `--check` works on a clean
 * machine. The stub never gets called in `--check` mode — the score is
 * only validated, not executed.
 */
function resolveProvider(): LLMProvider {
  if (SecretsManager.optional("ANTHROPIC_API_KEY") !== undefined) {
    return new AnthropicProvider();
  }
  return {
    async chat(): Promise<never> {
      throw new Error(
        "No ANTHROPIC_API_KEY in env. Set it before running the agent, " +
          "or run `npx tsx tutti.score.ts --check` to validate the score.",
      );
    },
    // eslint-disable-next-line @typescript-eslint/require-yield -- stub
    async *stream(): AsyncIterable<never> {
      throw new Error("stream not supported by the no-key stub provider");
    },
  };
}

const score = defineScore({
  name: "self-improving-skills",
  description:
    "A code-reviewer agent that learns a `review_pr` skill after five " +
    "successful PR reviews.",
  provider: resolveProvider(),
  default_model: "claude-sonnet-4-6",
  entry: "code-reviewer",

  agents: {
    "code-reviewer": {
      name: "Code Reviewer",
      role: "specialist",
      permissions: ["network", "filesystem"],
      voices: [new GitHubVoice(), new FilesystemVoice()],
      system_prompt: `Review the user's PR. Read each changed file,
comment on issues, summarise.

For each PR you are asked about:
  1. Look up the PR with get_pull_request.
  2. For every changed file in the PR, fetch its contents via
     get_file_contents and skim for obvious issues (typos, missing
     error handling, security smells).
  3. Post one consolidated review comment via comment_on_issue (the
     PR's underlying issue id is the same as the PR number).
  4. End with a one-paragraph summary back to the user.

Be concise. Don't speculate beyond what the diff shows.`,
    },
  },

  skills: {
    enabled: true,
    // Three trajectories is enough to demonstrate the proposer kicking
    // in within a short demo session. Production deployments should
    // leave this at the default (five) — fewer evidence runs means
    // more noise in proposals.
    auto_propose_threshold: 3,
  },
});

export default score;

/**
 * Returned from {@link createSkillStore} so the runtime, the CLI's
 * `skills` commands, and the README can all share the same in-memory
 * store across one process. In production you would back this with a
 * persistent store (e.g. a Postgres-backed implementation of
 * {@link SkillStore}).
 */
export const skillStore = new InMemorySkillStore();

/** Shared session store, exported for the same reason as {@link skillStore}. */
export const sessionStore = new InMemorySessionStore();

// ---------------------------------------------------------------------------
// Quick sanity check — `npx tsx tutti.score.ts --check`
//
// Prints the agent's voices, the skills config, and confirms the score
// loads without trying to authenticate with any provider. Use it to
// validate that the example is wired up correctly before running the
// agent end-to-end.
// ---------------------------------------------------------------------------

if (process.argv.includes("--check")) {
  const summary = {
    name: score.name,
    entry: score.entry,
    agents: Object.entries(score.agents).map(([id, a]) => ({
      id,
      name: a.name,
      role: a.role,
      voices: a.voices.map((v) => ({
        name: v.name,
        tool_count: v.tools.length,
      })),
      permissions: a.permissions,
    })),
    skills: score.skills,
    skill_store: skillStore.constructor.name,
    session_store: sessionStore.constructor.name,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  process.exit(0);
}
