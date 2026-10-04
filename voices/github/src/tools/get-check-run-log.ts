import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import type { Tool } from "@tuttiai/types";
import { ghErrorMessage, httpStatus } from "../utils/format.js";
import { decodeLogBody, tailLog } from "../utils/log-tail.js";

/** Lines returned when the caller does not ask for a number. */
export const DEFAULT_TAIL_LINES = 150;
/** The most lines one call may ask for. */
export const MAX_TAIL_LINES = 1000;
/** Upper bound on the characters returned, however long the lines are. */
export const MAX_LOG_CHARS = 40_000;

/** The app slug GitHub gives check runs created by GitHub Actions. */
const ACTIONS_APP = "github-actions";

const parameters = z.object({
  owner: z.string().describe("Repo owner or org"),
  repo: z.string().describe("Repository name"),
  check_run_id: z
    .number()
    .int()
    .positive()
    .describe("Check run id from list_pull_request_checks. For GitHub Actions it is the job id."),
  tail_lines: z
    .number()
    .int()
    .min(1)
    .max(MAX_TAIL_LINES)
    .default(DEFAULT_TAIL_LINES)
    .describe(`How many lines from the end of the log to return (max ${MAX_TAIL_LINES})`),
});

type Input = z.infer<typeof parameters>;

/** Which request was in flight when a failure happened, and whether the run had finished. */
interface Progress {
  step: "check" | "log";
  completed: boolean;
}

function describeFailure(error: unknown, input: Input, progress: Progress): string {
  const where = input.owner + "/" + input.repo;
  const status = httpStatus(error);
  const id = input.check_run_id;
  if (progress.step === "check" && status === 404) {
    return `[404] Check run ${id} not found in ${where}.\nTake the check_run_id from list_pull_request_checks.`;
  }
  if (progress.step === "log" && (status === 404 || status === 410)) {
    const why = progress.completed
      ? "It may have expired under the repository's log retention."
      : "The job has not finished; try again once it completes.";
    return `[${status}] No log available for job ${id} in ${where}.\n${why}`;
  }
  if (progress.step === "log" && status === 403) {
    return `[403] Could not read the log for job ${id} in ${where}.\nThe token needs read access to Actions (fine-grained: "Actions" read).`;
  }
  return ghErrorMessage(error, where);
}

function notActions(input: Input, slug: string, detailsUrl: string | null): string {
  return (
    `Check run ${input.check_run_id} comes from "${slug}", not GitHub Actions, so its log ` +
    `cannot be fetched through the GitHub API.\n` +
    `Read its summary with list_pull_request_checks${detailsUrl ? `, or open ${detailsUrl}` : ""}.`
  );
}

function render(input: Input, name: string, log: string): string {
  if (log.trim() === "") return `Log for "${name}" (job ${input.check_run_id}) is empty.`;
  const tail = tailLog(log, input.tail_lines, MAX_LOG_CHARS);
  const scope = tail.truncated
    ? `last ${tail.lines} of ${tail.totalLines} lines`
    : `all ${tail.totalLines} lines`;
  return `Log for "${name}" (job ${input.check_run_id}), ${scope}:\n${tail.text}`;
}

/**
 * Build the `get_check_run_log` tool.
 *
 * Fetches the log of a GitHub Actions job (whose job id is its check run id)
 * and returns only its last lines, bounded in both lines and characters, so a
 * developer agent can see why a build or test failed. Check runs from other
 * apps have no log behind the API and come back as an error naming their
 * details page. Read-only: it changes nothing on GitHub.
 *
 * @param octokit - Authenticated Octokit client.
 * @returns The tool, ready to add to a voice's `tools` array.
 */
export function createGetCheckRunLogTool(octokit: Octokit): Tool<Input> {
  return {
    name: "get_check_run_log",
    description:
      "Get the last lines of the log for a GitHub Actions check run (job), to see why a build " +
      "or test failed. Take check_run_id from list_pull_request_checks.",
    parameters,
    execute: async (input) => {
      const progress: Progress = { step: "check", completed: false };
      try {
        const { owner, repo } = input;
        const { data: run } = await octokit.checks.get({ owner, repo, check_run_id: input.check_run_id });
        const slug = run.app?.slug ?? "unknown";
        if (slug !== ACTIONS_APP) {
          return { content: notActions(input, slug, run.details_url ?? null), is_error: true };
        }
        progress.step = "log";
        progress.completed = run.status === "completed";
        // GitHub answers with a redirect to a short-lived download URL; Octokit follows it.
        const response = await octokit.actions.downloadJobLogsForWorkflowRun({
          owner,
          repo,
          job_id: input.check_run_id,
        });
        const log = decodeLogBody(response.data);
        if (log === undefined) {
          const page = run.html_url ?? "the run's page on GitHub";
          return {
            content: `GitHub returned no readable log for job ${input.check_run_id}.\nRead it at ${page}.`,
            is_error: true,
          };
        }
        return { content: render(input, run.name, log) };
      } catch (error) {
        return { content: describeFailure(error, input, progress), is_error: true };
      }
    },
  };
}
