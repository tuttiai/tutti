import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Octokit } from "@octokit/rest";
import type { ToolContext } from "@tuttiai/types";
import { createGetCommitTool, MAX_COMMIT_CHARS } from "../src/tools/get-commit.js";
import { createRerunWorkflowJobTool } from "../src/tools/rerun-workflow-job.js";

const ctx: ToolContext = { session_id: "test", agent_name: "test" };

// Mock Octokit: only the methods get_commit and rerun_workflow_job call.
function createMockOctokit() {
  return {
    repos: { getCommit: vi.fn() },
    actions: { getJobForWorkflowRun: vi.fn(), reRunJobForWorkflowRun: vi.fn() },
  };
}

let octokit: ReturnType<typeof createMockOctokit>;

// Safe: each tool only touches the methods the mock defines above.
const asOctokit = (): Octokit => octokit as unknown as Octokit;

beforeEach(() => {
  octokit = createMockOctokit();
});

function commit(files: unknown[]) {
  return {
    data: {
      sha: "abc",
      html_url: "u",
      parents: [{ sha: "p1" }],
      stats: { additions: 3, deletions: 1 },
      author: { login: "dev" },
      commit: { message: "fix(x): do it", author: { name: "Dev", date: "2026-10-05T10:00:00Z" } },
      files,
    },
  };
}

describe("get_commit", () => {
  const run = () => {
    const t = createGetCommitTool(asOctokit());
    return t.execute(t.parameters.parse({ owner: "o", repo: "r", sha: "abc" }), ctx);
  };

  it("shows the message, parents and each file's patch", async () => {
    octokit.repos.getCommit.mockResolvedValue(
      commit([
        { filename: "a.ts", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" },
        { filename: "logo.png", status: "added", additions: 0, deletions: 0, previous_filename: "old.png" },
      ]),
    );
    const result = await run();
    expect(octokit.repos.getCommit).toHaveBeenCalledWith({ owner: "o", repo: "r", ref: "abc" });
    expect(result.content).toContain("Commit abc in o/r");
    expect(result.content).toContain("Parents: p1");
    expect(result.content).toContain("fix(x): do it");
    expect(result.content).toContain("--- a.ts: modified, +3 -1\n@@ -1 +1 @@");
    expect(result.content).toContain("--- logo.png (from old.png): added");
    expect(result.content).toContain("(no patch: binary");
  });

  it("cuts at the character cap and names every file it left out", async () => {
    const big = "+".repeat(MAX_COMMIT_CHARS);
    octokit.repos.getCommit.mockResolvedValue(
      commit([
        { filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "+x" },
        { filename: "b.ts", status: "modified", additions: 1, deletions: 0, patch: big },
        { filename: "c.ts", status: "modified", additions: 1, deletions: 0, patch: "+y" },
      ]),
    );
    const result = await run();
    expect(result.content.length).toBeLessThan(MAX_COMMIT_CHARS + 300);
    expect(result.content).toContain("Not shown: b.ts, c.ts");
  });

  it("explains an unknown SHA", async () => {
    octokit.repos.getCommit.mockRejectedValue(Object.assign(new Error("No commit found"), { status: 422 }));
    const result = await run();
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('No commit "abc" in o/r');
  });

  it("is read-only", () => {
    expect(createGetCommitTool(asOctokit()).destructive).toBeUndefined();
  });
});

describe("rerun_workflow_job", () => {
  const run = () => {
    const t = createRerunWorkflowJobTool(asOctokit());
    return t.execute(t.parameters.parse({ owner: "o", repo: "r", check_run_id: 42 }), ctx);
  };
  const job = (status: string, conclusion: string | null) => ({ data: { name: "test", status, conclusion, run_id: 9 } });

  it.each(["failure", "cancelled", "timed_out"])("re-runs a job that finished as %s", async (conclusion) => {
    octokit.actions.getJobForWorkflowRun.mockResolvedValue(job("completed", conclusion));
    octokit.actions.reRunJobForWorkflowRun.mockResolvedValue({ data: {} });
    const result = await run();
    expect(result.is_error).toBeUndefined();
    expect(octokit.actions.reRunJobForWorkflowRun).toHaveBeenCalledWith({ owner: "o", repo: "r", job_id: 42 });
    expect(result.content).toContain('Re-running job "test" (42)');
  });

  it("refuses a job still running, and says a slow job is not a stuck one", async () => {
    octokit.actions.getJobForWorkflowRun.mockResolvedValue(job("in_progress", null));
    const result = await run();
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("is in progress, not finished");
    expect(result.content).toContain("A slow job is not a stuck one");
    expect(octokit.actions.reRunJobForWorkflowRun).not.toHaveBeenCalled();
  });

  it("refuses a job that passed", async () => {
    octokit.actions.getJobForWorkflowRun.mockResolvedValue(job("completed", "success"));
    const result = await run();
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("finished as success");
  });

  it("explains a missing job and a token without Actions write", async () => {
    octokit.actions.getJobForWorkflowRun.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }));
    expect((await run()).content).toContain("No GitHub Actions job 42");

    octokit.actions.getJobForWorkflowRun.mockResolvedValue(job("completed", "failure"));
    octokit.actions.reRunJobForWorkflowRun.mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));
    expect((await run()).content).toContain('"Actions" read and write');
  });

  it("is marked destructive", () => {
    expect(createRerunWorkflowJobTool(asOctokit()).destructive).toBe(true);
  });
});
