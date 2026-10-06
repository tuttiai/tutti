import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import type { Tool } from "@tuttiai/types";
import { ghErrorMessage, httpStatus } from "../utils/format.js";

/** The conclusions a job may be re-run from. A job that passed, or is still running, is left alone. */
export const RERUNNABLE_CONCLUSIONS: ReadonlySet<string> = new Set(["failure", "cancelled", "timed_out"]);

const parameters = z.object({
  owner: z.string().describe("Repo owner or org"),
  repo: z.string().describe("Repository name"),
  check_run_id: z
    .number()
    .int()
    .positive()
    .describe("Check run id from list_pull_request_checks. For GitHub Actions it is the job id."),
});

type Input = z.infer<typeof parameters>;

/** Which request was in flight when a failure happened. */
type Step = "job" | "rerun";

function describeFailure(error: unknown, input: Input, step: Step): string {
  const where = input.owner + "/" + input.repo;
  const status = httpStatus(error);
  if (step === "job" && status === 404) {
    return `[404] No GitHub Actions job ${input.check_run_id} in ${where}.\nTake the check_run_id from list_pull_request_checks; checks from other apps cannot be re-run here.`;
  }
  if (step === "rerun" && status === 403) {
    return `[403] Could not re-run job ${input.check_run_id} in ${where}.\nThe token needs write access to Actions (fine-grained: "Actions" read and write).`;
  }
  return ghErrorMessage(error, where);
}

function notRerunnable(input: Input, job: { name: string; status: string; conclusion: string | null }): string {
  if (job.status !== "completed") {
    return (
      `Job "${job.name}" (${input.check_run_id}) is ${job.status.replace(/_/g, " ")}, not finished, so it was not re-run.\n` +
      `A slow job is not a stuck one: check again with list_pull_request_checks before asking anyone to intervene.`
    );
  }
  return `Job "${job.name}" (${input.check_run_id}) finished as ${job.conclusion ?? "unknown"}; only failed, cancelled or timed-out jobs are re-run.`;
}

/**
 * Build the `rerun_workflow_job` tool.
 *
 * Re-runs one GitHub Actions job that failed, was cancelled or timed out,
 * with the jobs that depend on it, as the "Re-run job" button does. A job
 * still queued or in progress is refused with the advice to wait, and a job
 * that passed is refused too: re-running cannot fix a slow job, and a
 * passing one needs nothing.
 *
 * Marked `destructive` so it gates on human approval by default: it spends
 * the repository's Actions minutes.
 *
 * @param octokit - Authenticated Octokit client.
 * @returns The tool, ready to add to a voice's `tools` array.
 */
export function createRerunWorkflowJobTool(octokit: Octokit): Tool<Input> {
  return {
    name: "rerun_workflow_job",
    description:
      "Re-run one failed, cancelled or timed-out GitHub Actions job (and the jobs that depend on it). Take " +
      "check_run_id from list_pull_request_checks. Refuses a job still running or one that passed.",
    parameters,
    destructive: true,
    execute: async (input) => {
      let step: Step = "job";
      try {
        const { owner, repo } = input;
        const { data: job } = await octokit.actions.getJobForWorkflowRun({ owner, repo, job_id: input.check_run_id });
        if (job.status !== "completed" || !RERUNNABLE_CONCLUSIONS.has(job.conclusion ?? "")) {
          return { content: notRerunnable(input, job), is_error: true };
        }
        step = "rerun";
        await octokit.actions.reRunJobForWorkflowRun({ owner, repo, job_id: input.check_run_id });
        const lines = [
          `Re-running job "${job.name}" (${input.check_run_id}), which ${job.conclusion === "failure" ? "failed" : `was ${job.conclusion ?? "stopped"}`}.`,
          `Workflow run: ${job.run_id}`,
          `The new attempt gets a new check run id: read it with list_pull_request_checks.`,
        ];
        return { content: lines.join("\n") };
      } catch (error) {
        return { content: describeFailure(error, input, step), is_error: true };
      }
    },
  };
}
