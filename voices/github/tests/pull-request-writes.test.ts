import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Octokit } from "@octokit/rest";
import type { ToolContext } from "@tuttiai/types";
import { createUpdatePullRequestTool } from "../src/tools/update-pull-request.js";
import { createMarkReadyForReviewTool } from "../src/tools/mark-ready-for-review.js";
import { createUpdatePullRequestBranchTool } from "../src/tools/update-pull-request-branch.js";
import { createCreateReviewTool } from "../src/tools/create-review.js";

const ctx: ToolContext = { session_id: "test", agent_name: "test" };

// Mock Octokit: only the methods these four tools call.
function createMockOctokit() {
  return {
    pulls: { get: vi.fn(), update: vi.fn(), updateBranch: vi.fn(), createReview: vi.fn() },
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

  it("is marked destructive", () => {
    expect(createCreateReviewTool(asOctokit()).destructive).toBe(true);
  });
});
