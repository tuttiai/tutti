import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Octokit } from "@octokit/rest";
import type { ToolContext } from "@tuttiai/types";
import {
  createGetCheckRunLogTool,
  DEFAULT_TAIL_LINES,
  MAX_LOG_CHARS,
  MAX_TAIL_LINES,
} from "../src/tools/get-check-run-log.js";

const ctx: ToolContext = { session_id: "test", agent_name: "test" };

// Mock Octokit: only the methods get_check_run_log calls.
function createMockOctokit() {
  return {
    checks: { get: vi.fn() },
    actions: { downloadJobLogsForWorkflowRun: vi.fn() },
  };
}

let octokit: ReturnType<typeof createMockOctokit>;

function tool() {
  // Safe: the tool only touches the methods the mock defines above.
  return createGetCheckRunLogTool(octokit as unknown as Octokit);
}

function run(input: Record<string, unknown> = {}) {
  const t = tool();
  return t.execute(t.parameters.parse({ owner: "o", repo: "r", check_run_id: 42, ...input }), ctx);
}

function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
}

const failed = (status: number) => Object.assign(new Error("err"), { status });

beforeEach(() => {
  octokit = createMockOctokit();
  octokit.checks.get.mockResolvedValue({
    data: {
      name: "test",
      status: "completed",
      app: { slug: "github-actions" },
      details_url: "https://github.com/o/r/actions/runs/1/job/42",
      html_url: "https://github.com/o/r/runs/42",
    },
  });
  octokit.actions.downloadJobLogsForWorkflowRun.mockResolvedValue({ data: lines(500) });
});

describe("get_check_run_log", () => {
  it("returns the last tail_lines lines of the job log", async () => {
    const result = await run({ tail_lines: 3 });

    expect(result.is_error).toBeUndefined();
    expect(octokit.checks.get).toHaveBeenCalledWith({ owner: "o", repo: "r", check_run_id: 42 });
    expect(octokit.actions.downloadJobLogsForWorkflowRun).toHaveBeenCalledWith({ owner: "o", repo: "r", job_id: 42 });
    expect(result.content).toBe('Log for "test" (job 42), last 3 of 500 lines:\nline 498\nline 499\nline 500');
  });

  it("defaults to DEFAULT_TAIL_LINES and says when the log is shown whole", async () => {
    const tailed = await run();
    expect(tailed.content).toContain(`last ${DEFAULT_TAIL_LINES} of 500 lines`);

    octokit.actions.downloadJobLogsForWorkflowRun.mockResolvedValue({ data: lines(4) });
    const whole = await run();
    expect(whole.content).toContain("all 4 lines");
  });

  it("decodes a binary log body", async () => {
    const bytes = new TextEncoder().encode("a\nb\nError: boom\n");
    octokit.actions.downloadJobLogsForWorkflowRun.mockResolvedValue({ data: bytes.buffer });

    const result = await run();

    expect(result.content).toContain("Error: boom");
  });

  it("bounds the result in characters however long the lines are", async () => {
    octokit.actions.downloadJobLogsForWorkflowRun.mockResolvedValue({ data: "x".repeat(MAX_LOG_CHARS * 3) });

    const result = await run();

    expect(result.content.length).toBeLessThan(MAX_LOG_CHARS + 200);
    expect(result.content).toContain("last 1 of 1 lines");
  });

  it("refuses a tail_lines above the maximum", () => {
    expect(() =>
      tool().parameters.parse({ owner: "o", repo: "r", check_run_id: 1, tail_lines: MAX_TAIL_LINES + 1 }),
    ).toThrow();
  });

  it("explains that a non-Actions check run has no fetchable log", async () => {
    octokit.checks.get.mockResolvedValue({
      data: { name: "codecov", status: "completed", app: { slug: "codecov" }, details_url: "https://codecov.io/x" },
    });

    const result = await run();

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('comes from "codecov", not GitHub Actions');
    expect(result.content).toContain("https://codecov.io/x");
    expect(octokit.actions.downloadJobLogsForWorkflowRun).not.toHaveBeenCalled();
  });

  it("reports an empty log plainly", async () => {
    octokit.actions.downloadJobLogsForWorkflowRun.mockResolvedValue({ data: "" });

    const result = await run();

    expect(result.content).toBe('Log for "test" (job 42) is empty.');
  });

  it("errors with the run's page when the body is unreadable", async () => {
    octokit.actions.downloadJobLogsForWorkflowRun.mockResolvedValue({ data: { unexpected: true } });

    const result = await run();

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("https://github.com/o/r/runs/42");
  });

  it("reports a missing check run with a hint", async () => {
    octokit.checks.get.mockRejectedValue(failed(404));

    const result = await run();

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Check run 42 not found in o/r");
  });

  it("says an expired log may have aged out", async () => {
    octokit.actions.downloadJobLogsForWorkflowRun.mockRejectedValue(failed(410));

    const result = await run();

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("[410] No log available for job 42");
    expect(result.content).toContain("retention");
  });

  it("says a running job has no log yet", async () => {
    octokit.checks.get.mockResolvedValue({
      data: { name: "test", status: "in_progress", app: { slug: "github-actions" }, details_url: null },
    });
    octokit.actions.downloadJobLogsForWorkflowRun.mockRejectedValue(failed(404));

    const result = await run();

    expect(result.content).toContain("has not finished");
  });

  it("names the missing token permission on 403", async () => {
    octokit.actions.downloadJobLogsForWorkflowRun.mockRejectedValue(failed(403));

    const result = await run();

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('"Actions" read');
  });

  it("reports other failures through the shared formatter", async () => {
    octokit.actions.downloadJobLogsForWorkflowRun.mockRejectedValue(new Error("socket hang up"));

    const result = await run();

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("GitHub API error for o/r: socket hang up");
  });

  it("is read-only", () => {
    expect(tool().destructive).toBeUndefined();
  });
});
