import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import type { Tool } from "@tuttiai/types";
import { ghErrorMessage, httpStatus } from "../utils/format.js";
import {
  checkRunBucket,
  commitStatusBucket,
  formatCheckRun,
  formatCommitStatus,
  overallLine,
} from "../utils/checks-format.js";
import type { CheckRunSummary, CommitStatusSummary } from "../utils/checks-format.js";

const parameters = z.object({
  owner: z.string().describe("Repo owner or org"),
  repo: z.string().describe("Repository name"),
  pr_number: z.number().int().describe("Pull request number"),
});

type Input = z.infer<typeof parameters>;

/** GitHub's page-size ceiling for both check runs and commit statuses. */
const PER_PAGE = 100;

/** Which request was in flight when a failure happened. */
type Step = "pr" | "checks";

function describeFailure(error: unknown, input: Input, step: Step): string {
  const where = input.owner + "/" + input.repo;
  const status = httpStatus(error);
  if (step === "pr" && status === 404) {
    return `[404] Pull request #${input.pr_number} not found in ${where}.\nCheck the number with list_pull_requests.`;
  }
  if (step === "checks" && status === 403) {
    return (
      `[403] Could not read checks for PR #${input.pr_number} in ${where}.\n` +
      `The token needs read access to checks and commit statuses (fine-grained: "Checks" and "Commit statuses" read).`
    );
  }
  return ghErrorMessage(error, where);
}

function renderChecks(sha: string, runs: CheckRunSummary[], total: number): string[] {
  const shown = total > runs.length ? ` (showing ${runs.length} of ${total})` : "";
  if (runs.length === 0) return [`Check runs on ${sha}: none`];
  return [`Check runs on ${sha}${shown}:`, ...runs.flatMap(formatCheckRun)];
}

function renderStatuses(combined: string, statuses: CommitStatusSummary[]): string[] {
  // An empty combined status still reports "pending", so say "none" rather than repeat it.
  if (statuses.length === 0) return ["Commit statuses: none"];
  return [`Commit statuses (combined: ${combined}):`, ...statuses.map(formatCommitStatus)];
}

/**
 * Build the `list_pull_request_checks` tool.
 *
 * Resolves a pull request's head commit and reports every check run on it
 * plus the combined commit status, ending with one overall line and a
 * verdict, so an agent can tell whether CI passed before calling its work
 * done. Read-only: it changes nothing on GitHub.
 *
 * @param octokit - Authenticated Octokit client.
 * @returns The tool, ready to add to a voice's `tools` array.
 */
export function createListPullRequestChecksTool(octokit: Octokit): Tool<Input> {
  return {
    name: "list_pull_request_checks",
    description:
      "List the CI check runs and commit statuses on a pull request's head commit, with an " +
      "overall passed/failed/pending count. Use get_check_run_log with a check_run_id to see why one failed.",
    parameters,
    execute: async (input) => {
      let step: Step = "pr";
      try {
        const { owner, repo } = input;
        const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: input.pr_number });
        const sha = pr.head.sha;
        step = "checks";
        const [{ data: checks }, { data: combined }] = await Promise.all([
          octokit.checks.listForRef({ owner, repo, ref: sha, per_page: PER_PAGE }),
          octokit.repos.getCombinedStatusForRef({ owner, repo, ref: sha, per_page: PER_PAGE }),
        ]);
        const runs: CheckRunSummary[] = checks.check_runs;
        const statuses: CommitStatusSummary[] = combined.statuses;
        const buckets = [...runs.map(checkRunBucket), ...statuses.map((s) => commitStatusBucket(s.state))];
        const lines = [
          `PR #${pr.number} in ${owner}/${repo}: ${pr.head.ref} @ ${sha}`,
          overallLine(buckets),
          "",
          ...renderChecks(sha, runs, checks.total_count),
          "",
          ...renderStatuses(combined.state, statuses),
        ];
        return { content: lines.join("\n") };
      } catch (error) {
        return { content: describeFailure(error, input, step), is_error: true };
      }
    },
  };
}
