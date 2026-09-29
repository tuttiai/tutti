import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Octokit } from "@octokit/rest";
import type { ToolContext } from "@tuttiai/types";
import { createCreateBranchTool } from "../src/tools/create-branch.js";

const ctx: ToolContext = { session_id: "test", agent_name: "test" };

// Mock Octokit: only the methods create_branch calls.
function createMockOctokit() {
  return {
    repos: { get: vi.fn() },
    git: { getRef: vi.fn(), createRef: vi.fn() },
  };
}

let octokit: ReturnType<typeof createMockOctokit>;

function tool() {
  // Safe: the tool only touches the methods the mock defines above.
  return createCreateBranchTool(octokit as unknown as Octokit);
}

function run(input: Record<string, unknown>) {
  const t = tool();
  return t.execute(t.parameters.parse({ owner: "o", repo: "r", ...input }), ctx);
}

beforeEach(() => {
  octokit = createMockOctokit();
  octokit.repos.get.mockResolvedValue({ data: { default_branch: "main" } });
  octokit.git.getRef.mockResolvedValue({ data: { object: { sha: "abc123" } } });
  octokit.git.createRef.mockResolvedValue({ data: {} });
});

describe("create_branch", () => {
  it("branches from the default branch when from is omitted", async () => {
    const result = await run({ branch: "feat/x" });

    expect(result.is_error).toBeUndefined();
    expect(octokit.repos.get).toHaveBeenCalledWith({ owner: "o", repo: "r" });
    expect(octokit.git.getRef).toHaveBeenCalledWith({ owner: "o", repo: "r", ref: "heads/main" });
    expect(octokit.git.createRef).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      ref: "refs/heads/feat/x",
      sha: "abc123",
    });
    expect(result.content).toContain("Created branch feat/x in o/r");
    expect(result.content).toContain("Base branch: main");
    expect(result.content).toContain("Base SHA: abc123");
  });

  it("branches from the named branch without looking up the default", async () => {
    const result = await run({ branch: "feat/x", from: "develop" });

    expect(octokit.repos.get).not.toHaveBeenCalled();
    expect(octokit.git.getRef).toHaveBeenCalledWith({ owner: "o", repo: "r", ref: "heads/develop" });
    expect(result.content).toContain("Base branch: develop");
  });

  it("is marked destructive so it gates on approval by default", () => {
    expect(tool().destructive).toBe(true);
  });

  it("hints at commit_files when the branch already exists", async () => {
    octokit.git.createRef.mockRejectedValue(
      Object.assign(new Error("Reference already exists"), { status: 422 }),
    );

    const result = await run({ branch: "feat/x" });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Branch "feat/x" already exists in o/r');
    expect(result.content).toContain("commit_files");
  });

  it("reports any other 422 through the shared formatter", async () => {
    octokit.git.createRef.mockRejectedValue(
      Object.assign(new Error("Reference name is not valid"), { status: 422 }),
    );

    const result = await run({ branch: "bad..name" });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("validation failed");
    expect(result.content).not.toContain("already exists");
  });

  it("says which base branch is missing when getRef answers 404", async () => {
    octokit.git.getRef.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));

    const result = await run({ branch: "feat/x", from: "nope" });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Base branch "nope" not found in o/r');
    expect(octokit.git.createRef).not.toHaveBeenCalled();
  });

  it("reports a missing repository through the shared formatter", async () => {
    octokit.repos.get.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));

    const result = await run({ branch: "feat/x" });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Not found for o/r");
    expect(octokit.git.getRef).not.toHaveBeenCalled();
  });

  it("rejects input that is missing the branch name", () => {
    expect(() => tool().parameters.parse({ owner: "o", repo: "r" })).toThrow();
  });
});
