import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Octokit } from "@octokit/rest";
import type { ToolContext } from "@tuttiai/types";
import { createUpdatePullRequestTool } from "../src/tools/update-pull-request.js";
import { createMarkReadyForReviewTool } from "../src/tools/mark-ready-for-review.js";
import { createUpdatePullRequestBranchTool } from "../src/tools/update-pull-request-branch.js";
import { createCreateReviewTool } from "../src/tools/create-review.js";
import { createMergePullRequestTool } from "../src/tools/merge-pull-request.js";

const ctx: ToolContext = { session_id: "test", agent_name: "test" };

// Mock Octokit: only the methods these five tools call, plus the file list create_review reads.
function createMockOctokit() {
  return {
    pulls: {
      get: vi.fn(),
      update: vi.fn(),
      updateBranch: vi.fn(),
      createReview: vi.fn(),
      merge: vi.fn(),
      listFiles: vi.fn(),
    },
    paginate: vi.fn(),
    graphql: vi.fn(),
  };
}

let octokit: ReturnType<typeof createMockOctokit>;

// Safe: each tool only touches the methods the mock defines above.
const asOctokit = (): Octokit => octokit as unknown as Octokit;

beforeEach(() => {
  octokit = createMockOctokit();
});

describe("update_pull_request", () => {
  const run = (input: Record<string, unknown>) => {
    const t = createUpdatePullRequestTool(asOctokit());
    return t.execute(t.parameters.parse({ owner: "o", repo: "r", pr_number: 7, ...input }), ctx);
  };

  it("sends only the fields given", async () => {
    octokit.pulls.update.mockResolvedValue({ data: { number: 7, title: "New", html_url: "u" } });
    const result = await run({ title: "New" });
    expect(octokit.pulls.update).toHaveBeenCalledWith({ owner: "o", repo: "r", pull_number: 7, title: "New" });
    expect(result.content).toContain("Updated pull request #7: title");
  });

  it("updates title and description together", async () => {
    octokit.pulls.update.mockResolvedValue({ data: { number: 7, title: "T", html_url: "u" } });
    const result = await run({ title: "T", body: "B" });
    expect(octokit.pulls.update).toHaveBeenCalledWith({ owner: "o", repo: "r", pull_number: 7, title: "T", body: "B" });
    expect(result.content).toContain("title and description");
  });

  it("refuses a call that changes nothing, without a request", async () => {
    const result = await run({});
    expect(result.is_error).toBe(true);
    expect(octokit.pulls.update).not.toHaveBeenCalled();
  });

  it("returns an error instead of throwing", async () => {
    octokit.pulls.update.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    const result = await run({ body: "x" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("[404]");
  });

  it("is marked destructive", () => {
    expect(createUpdatePullRequestTool(asOctokit()).destructive).toBe(true);
  });
});

describe("mark_ready_for_review", () => {
  const run = () => {
    const t = createMarkReadyForReviewTool(asOctokit());
    return t.execute(t.parameters.parse({ owner: "o", repo: "r", pr_number: 7 }), ctx);
  };

  it("takes a draft out of draft through GraphQL", async () => {
    octokit.pulls.get.mockResolvedValue({ data: { number: 7, draft: true, node_id: "PR_1", title: "T", html_url: "u" } });
    octokit.graphql.mockResolvedValue({});
    const result = await run();
    expect(octokit.graphql).toHaveBeenCalledWith(expect.stringContaining("markPullRequestReadyForReview"), { id: "PR_1" });
    expect(result.content).toContain("Marked pull request #7 ready for review");
  });

  it("reports a pull request that is already ready, without writing", async () => {
    octokit.pulls.get.mockResolvedValue({ data: { number: 7, draft: false, node_id: "PR_1", title: "T", html_url: "u" } });
    const result = await run();
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("already ready");
    expect(octokit.graphql).not.toHaveBeenCalled();
  });

  it("returns an error instead of throwing", async () => {
    octokit.pulls.get.mockResolvedValue({ data: { number: 7, draft: true, node_id: "PR_1", title: "T", html_url: "u" } });
    octokit.graphql.mockRejectedValue(new Error("Resource not accessible by integration"));
    const result = await run();
    expect(result.is_error).toBe(true);
  });

  it("is marked destructive", () => {
    expect(createMarkReadyForReviewTool(asOctokit()).destructive).toBe(true);
  });
});

describe("merge_pull_request", () => {
  const run = (input: Record<string, unknown> = {}) => {
    const t = createMergePullRequestTool(asOctokit());
    return t.execute(t.parameters.parse({ owner: "o", repo: "r", pr_number: 7, expected_head_sha: "abc", ...input }), ctx);
  };

  it("merges at the checked head with a merge commit by default", async () => {
    octokit.pulls.merge.mockResolvedValue({ data: { merged: true, sha: "def", message: "Pull Request successfully merged" } });
    const result = await run();
    expect(octokit.pulls.merge).toHaveBeenCalledWith({ owner: "o", repo: "r", pull_number: 7, sha: "abc", merge_method: "merge" });
    expect(result.content).toContain("Merged pull request #7");
    expect(result.content).toContain("def");
  });

  it("passes the merge method given", async () => {
    octokit.pulls.merge.mockResolvedValue({ data: { merged: true, sha: "def", message: "ok" } });
    await run({ merge_method: "squash" });
    expect(octokit.pulls.merge).toHaveBeenCalledWith(expect.objectContaining({ merge_method: "squash" }));
  });

  it("requires the head SHA that was checked", () => {
    const t = createMergePullRequestTool(asOctokit());
    expect(() => t.parameters.parse({ owner: "o", repo: "r", pr_number: 7 })).toThrow();
  });

  it("explains a moved head", async () => {
    octokit.pulls.merge.mockRejectedValue(Object.assign(new Error("Head branch was modified"), { status: 409 }));
    const result = await run();
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("no longer abc");
  });

  it("explains a pull request GitHub will not merge", async () => {
    octokit.pulls.merge.mockRejectedValue(Object.assign(new Error("Pull Request is not mergeable"), { status: 405 }));
    const result = await run();
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Pull Request is not mergeable");
  });

  it("passes other failures to the shared formatter", async () => {
    octokit.pulls.merge.mockRejectedValue(Object.assign(new Error("Bad credentials"), { status: 401 }));
    expect((await run()).content).toContain("authentication failed");
  });

  it("is marked destructive", () => {
    expect(createMergePullRequestTool(asOctokit()).destructive).toBe(true);
  });
});

describe("update_pull_request_branch", () => {
  const run = (input: Record<string, unknown> = {}) => {
    const t = createUpdatePullRequestBranchTool(asOctokit());
    return t.execute(t.parameters.parse({ owner: "o", repo: "r", pr_number: 7, ...input }), ctx);
  };

  it("asks GitHub to merge the base in, passing the expected head when given", async () => {
    octokit.pulls.updateBranch.mockResolvedValue({ data: { message: "Updating pull request branch." } });
    const result = await run({ expected_head_sha: "abc" });
    expect(octokit.pulls.updateBranch).toHaveBeenCalledWith({ owner: "o", repo: "r", pull_number: 7, expected_head_sha: "abc" });
    expect(result.content).toContain("Updating pull request branch.");
  });

  it("explains a refusal: moved head or conflicts", async () => {
    octokit.pulls.updateBranch.mockRejectedValue(Object.assign(new Error("merge conflict between base and head"), { status: 422 }));
    const result = await run();
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("would not update the branch of PR #7");
    expect(result.content).toContain("conflicts");
  });

  it("passes other failures to the shared formatter", async () => {
    octokit.pulls.updateBranch.mockRejectedValue(Object.assign(new Error("Bad credentials"), { status: 401 }));
    expect((await run()).content).toContain("authentication failed");
  });

  it("is marked destructive", () => {
    expect(createUpdatePullRequestBranchTool(asOctokit()).destructive).toBe(true);
  });
});

describe("create_review", () => {
  const run = (input: Record<string, unknown>) => {
    const t = createCreateReviewTool(asOctokit());
    return t.execute(t.parameters.parse({ owner: "o", repo: "r", pr_number: 7, body: "Looks right.", ...input }), ctx);
  };

  it("submits the review with its event, body and pinned commit", async () => {
    octokit.pulls.createReview.mockResolvedValue({ data: { state: "CHANGES_REQUESTED", commit_id: "abc", html_url: "u" } });
    const result = await run({ event: "REQUEST_CHANGES", commit_id: "abc" });
    expect(octokit.pulls.createReview).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      pull_number: 7,
      event: "REQUEST_CHANGES",
      body: "Looks right.",
      commit_id: "abc",
    });
    expect(result.content).toContain("Submitted a changes requested review on pull request #7");
  });

  it("points at COMMENT when GitHub refuses a review of one's own pull request", async () => {
    octokit.pulls.createReview.mockRejectedValue(
      Object.assign(new Error("Can not approve your own pull request"), { status: 422 }),
    );
    const result = await run({ event: "APPROVE" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("event COMMENT");
  });

  it("requires a body and a known event", () => {
    const t = createCreateReviewTool(asOctokit());
    expect(() => t.parameters.parse({ owner: "o", repo: "r", pr_number: 7, event: "APPROVE", body: "" })).toThrow();
    expect(() => t.parameters.parse({ owner: "o", repo: "r", pr_number: 7, event: "MERGE", body: "x" })).toThrow();
  });

  it("passes other failures to the shared formatter", async () => {
    octokit.pulls.createReview.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    expect((await run({ event: "COMMENT" })).content).toContain("[404]");
  });

  describe("line comments", () => {
    // One hunk: new lines 10-14 of src/a.ts, old lines 10-12.
    const files = [
      { filename: "src/a.ts", patch: "@@ -10,3 +10,5 @@ fn\n x\n+y\n+z\n w\n v" },
      { filename: "logo.png" },
    ];
    const posted = { data: { state: "COMMENTED", commit_id: "abc", html_url: "u" } };

    it("posts a comment on a changed line inline, defaulting to the new side", async () => {
      octokit.paginate.mockResolvedValue(files);
      octokit.pulls.createReview.mockResolvedValue(posted);
      const result = await run({ event: "COMMENT", comments: [{ path: "src/a.ts", line: 11, body: "Null here?" }] });
      expect(octokit.paginate).toHaveBeenCalledWith(octokit.pulls.listFiles, {
        owner: "o",
        repo: "r",
        pull_number: 7,
        per_page: 100,
      });
      expect(octokit.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          body: "Looks right.",
          comments: [{ path: "src/a.ts", line: 11, side: "RIGHT", body: "Null here?" }],
        }),
      );
      expect(result.content).toContain("Line comments: 1 on the diff, 0 moved into the body");
    });

    it("posts a range with its start on the same side", async () => {
      octokit.paginate.mockResolvedValue(files);
      octokit.pulls.createReview.mockResolvedValue(posted);
      await run({ event: "COMMENT", comments: [{ path: "src/a.ts", start_line: 10, line: 12, side: "LEFT", body: "b" }] });
      expect(octokit.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          comments: [{ path: "src/a.ts", line: 12, side: "LEFT", body: "b", start_line: 10, start_side: "LEFT" }],
        }),
      );
    });

    it("moves a comment outside the diff, or on a file without a patch, into the body", async () => {
      octokit.paginate.mockResolvedValue(files);
      octokit.pulls.createReview.mockResolvedValue(posted);
      const result = await run({
        event: "COMMENT",
        comments: [
          { path: "src/a.ts", line: 40, body: "Far away" },
          { path: "logo.png", line: 1, body: "Binary" },
          { path: "src/missing.ts", start_line: 2, line: 3, body: "Not in the PR" },
        ],
      });
      // Safe: the mock records the request object the tool built.
      const call = octokit.pulls.createReview.mock.calls[0]?.[0] as { body: string; comments?: unknown };
      expect(call.comments).toBeUndefined();
      expect(call.body).toContain("**Comments not on a line this pull request changed**");
      expect(call.body).toContain("**`src/a.ts`, line 40**\n\nFar away");
      expect(call.body).toContain("**`src/missing.ts`, lines 2-3**\n\nNot in the PR");
      expect(result.content).toContain("0 on the diff, 3 moved into the body");
    });

    it("retries with every comment in the body when GitHub still refuses a line", async () => {
      octokit.paginate.mockResolvedValue(files);
      octokit.pulls.createReview
        .mockRejectedValueOnce(Object.assign(new Error("Line could not be resolved"), { status: 422 }))
        .mockResolvedValueOnce(posted);
      const result = await run({ event: "COMMENT", comments: [{ path: "src/a.ts", line: 11, body: "Null here?" }] });
      expect(octokit.pulls.createReview).toHaveBeenCalledTimes(2);
      // Safe: the mock records the request object the tool built.
      const retry = octokit.pulls.createReview.mock.calls[1]?.[0] as { body: string; comments?: unknown };
      expect(retry.comments).toBeUndefined();
      expect(retry.body).toContain("Null here?");
      expect(result.content).toContain("0 on the diff, 1 moved into the body");
    });

    it("does not retry a refusal that is not about a line", async () => {
      octokit.paginate.mockResolvedValue(files);
      octokit.pulls.createReview.mockRejectedValue(Object.assign(new Error("Validation Failed: body"), { status: 422 }));
      const result = await run({ event: "COMMENT", comments: [{ path: "src/a.ts", line: 11, body: "x" }] });
      expect(octokit.pulls.createReview).toHaveBeenCalledTimes(1);
      expect(result.is_error).toBe(true);
    });

    it("tries every comment inline when the file list cannot be read", async () => {
      octokit.paginate.mockRejectedValue(Object.assign(new Error("Server Error"), { status: 500 }));
      octokit.pulls.createReview.mockResolvedValue(posted);
      await run({ event: "COMMENT", comments: [{ path: "src/a.ts", line: 99, body: "x" }] });
      expect(octokit.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({ comments: [{ path: "src/a.ts", line: 99, side: "RIGHT", body: "x" }] }),
      );
    });

    it("reads no file list for a review without line comments", async () => {
      octokit.pulls.createReview.mockResolvedValue(posted);
      const result = await run({ event: "COMMENT" });
      expect(octokit.paginate).not.toHaveBeenCalled();
      expect(result.content).not.toContain("Line comments");
    });

    it("refuses a range that does not run forwards, and more than 50 comments", () => {
      const t = createCreateReviewTool(asOctokit());
      const base = { owner: "o", repo: "r", pr_number: 7, event: "COMMENT", body: "x" };
      expect(() => t.parameters.parse({ ...base, comments: [{ path: "a", start_line: 5, line: 5, body: "b" }] })).toThrow();
      const many = Array.from({ length: 51 }, () => ({ path: "a", line: 1, body: "b" }));
      expect(() => t.parameters.parse({ ...base, comments: many })).toThrow();
    });
  });

  it("is marked destructive", () => {
    expect(createCreateReviewTool(asOctokit()).destructive).toBe(true);
  });
});
