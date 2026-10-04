import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Octokit } from "@octokit/rest";
import type { ToolContext } from "@tuttiai/types";
import { createListPullRequestChecksTool } from "../src/tools/list-pull-request-checks.js";

const ctx: ToolContext = { session_id: "test", agent_name: "test" };

// Mock Octokit: only the methods list_pull_request_checks calls.
function createMockOctokit() {
  return {
    pulls: { get: vi.fn() },
    checks: { listForRef: vi.fn() },
    repos: { getCombinedStatusForRef: vi.fn() },
  };
}

let octokit: ReturnType<typeof createMockOctokit>;

function tool() {
  // Safe: the tool only touches the methods the mock defines above.
  return createListPullRequestChecksTool(octokit as unknown as Octokit);
}

function run(input: Record<string, unknown> = {}) {
  const t = tool();
  return t.execute(t.parameters.parse({ owner: "o", repo: "r", pr_number: 7, ...input }), ctx);
}

function checkRun(overrides: Record<string, unknown>) {
  return {
    id: 1,
    name: "build",
    status: "completed",
    conclusion: "success",
    started_at: "2026-10-04T10:00:00Z",
    completed_at: "2026-10-04T10:05:00Z",
    html_url: "https://github.com/o/r/runs/1",
    output: { title: null, summary: null },
    app: { slug: "github-actions" },
    ...overrides,
  };
}

function withChecks(runs: unknown[], statuses: unknown[] = [], total = runs.length) {
  octokit.checks.listForRef.mockResolvedValue({ data: { total_count: total, check_runs: runs } });
  octokit.repos.getCombinedStatusForRef.mockResolvedValue({
    data: { state: statuses.length === 0 ? "pending" : "success", statuses },
  });
}

beforeEach(() => {
  octokit = createMockOctokit();
  octokit.pulls.get.mockResolvedValue({
    data: { number: 7, head: { ref: "feat/x", sha: "deadbeef" } },
  });
});

describe("list_pull_request_checks", () => {
  it("lists every check run on the PR's head SHA with an overall line", async () => {
    withChecks([
      checkRun({ id: 11, name: "build" }),
      checkRun({ id: 12, name: "test", conclusion: "failure", output: { title: "2 tests failed", summary: "x" } }),
      checkRun({ id: 13, name: "lint", status: "in_progress", conclusion: null, completed_at: null }),
      checkRun({ id: 14, name: "docs", conclusion: "skipped" }),
    ]);

    const result = await run();

    expect(result.is_error).toBeUndefined();
    expect(octokit.pulls.get).toHaveBeenCalledWith({ owner: "o", repo: "r", pull_number: 7 });
    expect(octokit.checks.listForRef).toHaveBeenCalledWith({ owner: "o", repo: "r", ref: "deadbeef", per_page: 100 });
    expect(result.content).toContain("PR #7 in o/r: feat/x @ deadbeef");
    expect(result.content).toContain("Overall: 1 passed, 1 failed, 1 pending, 1 skipped (verdict: failing)");
    expect(result.content).toContain("[failed] test: failure  (check_run_id 12, app github-actions)");
    expect(result.content).toContain("[pending] lint: in_progress");
    expect(result.content).toContain("Title: 2 tests failed");
    expect(result.content).toContain("URL: https://github.com/o/r/runs/1");
    expect(result.content).toContain("Commit statuses: none");
  });

  it("calls the run green only when everything passed", async () => {
    withChecks([checkRun({})], [{ context: "ci/legacy", state: "success", description: "ok", target_url: null }]);

    const result = await run();

    expect(result.content).toContain("Overall: 2 passed, 0 failed, 0 pending, 0 skipped (verdict: green)");
    expect(result.content).toContain("Commit statuses (combined: success):");
    expect(result.content).toContain("[passed] ci/legacy: success - ok");
  });

  it("counts failing and pending commit statuses", async () => {
    withChecks(
      [],
      [
        { context: "a", state: "error", description: null, target_url: "https://ci/a" },
        { context: "b", state: "pending", description: null, target_url: null },
      ],
    );

    const result = await run();

    expect(result.content).toContain("Overall: 0 passed, 1 failed, 1 pending, 0 skipped (verdict: failing)");
    expect(result.content).toContain("Check runs on deadbeef: none");
    expect(result.content).toContain("[failed] a: error  https://ci/a");
  });

  it("never reads an empty PR as green", async () => {
    withChecks([]);

    const result = await run();

    expect(result.content).toContain("(verdict: no checks)");
  });

  it("truncates a long output summary and says when only one page is shown", async () => {
    withChecks([checkRun({ output: { title: null, summary: "y".repeat(1000) } })], [], 250);

    const result = await run();

    expect(result.content).toContain("(showing 1 of 250)");
    const summary = result.content.split("\n").find((l) => l.includes("Summary:")) ?? "";
    expect(summary.length).toBeLessThan(320);
    expect(summary.endsWith("...")).toBe(true);
  });

  it("reports a missing PR with a hint and does not look for checks", async () => {
    octokit.pulls.get.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));

    const result = await run();

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Pull request #7 not found in o/r");
    expect(result.content).toContain("list_pull_requests");
    expect(octokit.checks.listForRef).not.toHaveBeenCalled();
  });

  it("names the missing token permission when checks answer 403", async () => {
    withChecks([]);
    octokit.checks.listForRef.mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));

    const result = await run();

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('"Checks" and "Commit statuses" read');
  });

  it("reports other failures through the shared formatter", async () => {
    withChecks([]);
    octokit.repos.getCombinedStatusForRef.mockRejectedValue(new Error("boom"));

    const result = await run();

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("GitHub API error for o/r: boom");
  });

  it("is read-only", () => {
    expect(tool().destructive).toBeUndefined();
  });

  it("rejects input that is missing the PR number", () => {
    expect(() => tool().parameters.parse({ owner: "o", repo: "r" })).toThrow();
  });
});
