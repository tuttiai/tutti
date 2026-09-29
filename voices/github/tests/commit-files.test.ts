import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Octokit } from "@octokit/rest";
import type { ToolContext } from "@tuttiai/types";
import { createCommitFilesTool } from "../src/tools/commit-files.js";

const ctx: ToolContext = { session_id: "test", agent_name: "test" };

// Mock Octokit: only the methods commit_files calls.
function createMockOctokit() {
  return {
    repos: { get: vi.fn() },
    git: {
      getRef: vi.fn(),
      getCommit: vi.fn(),
      createTree: vi.fn(),
      createCommit: vi.fn(),
      updateRef: vi.fn(),
    },
  };
}

let octokit: ReturnType<typeof createMockOctokit>;

function tool() {
  // Safe: the tool only touches the methods the mock defines above.
  return createCommitFilesTool(octokit as unknown as Octokit);
}

function run(input: Record<string, unknown>) {
  const t = tool();
  return t.execute(
    t.parameters.parse({ owner: "o", repo: "r", branch: "feat/x", message: "Add things", ...input }),
    ctx,
  );
}

function allGitCalls(): number {
  return Object.values(octokit.git).reduce((n, fn) => n + fn.mock.calls.length, 0);
}

beforeEach(() => {
  octokit = createMockOctokit();
  octokit.repos.get.mockResolvedValue({ data: { default_branch: "main" } });
  octokit.git.getRef.mockResolvedValue({ data: { object: { sha: "head1" } } });
  octokit.git.getCommit.mockResolvedValue({ data: { tree: { sha: "tree0" } } });
  octokit.git.createTree.mockResolvedValue({ data: { sha: "tree1" } });
  octokit.git.createCommit.mockResolvedValue({
    data: { sha: "commit1", html_url: "https://github.com/o/r/commit/commit1" },
  });
  octokit.git.updateRef.mockResolvedValue({ data: {} });
});

describe("commit_files", () => {
  describe("happy path", () => {
    it("builds a tree on the head, commits it and fast-forwards the branch", async () => {
      const result = await run({
        files: [{ path: "src/a.ts", content: "export const a = 1;\n" }],
        deletions: ["old.txt"],
      });

      expect(result.is_error).toBeUndefined();
      expect(octokit.git.getRef).toHaveBeenCalledWith({ owner: "o", repo: "r", ref: "heads/feat/x" });
      expect(octokit.git.getCommit).toHaveBeenCalledWith({ owner: "o", repo: "r", commit_sha: "head1" });
      expect(octokit.git.createTree).toHaveBeenCalledWith({
        owner: "o",
        repo: "r",
        base_tree: "tree0",
        tree: [
          { path: "src/a.ts", mode: "100644", type: "blob", content: "export const a = 1;\n" },
          { path: "old.txt", mode: "100644", type: "blob", sha: null },
        ],
      });
      expect(octokit.git.createCommit).toHaveBeenCalledWith({
        owner: "o",
        repo: "r",
        message: "Add things",
        tree: "tree1",
        parents: ["head1"],
      });
      expect(result.content).toContain("Committed to branch feat/x in o/r");
      expect(result.content).toContain("Commit: commit1");
      expect(result.content).toContain("Files changed: 1  Deleted: 1");
      expect(result.content).toContain("https://github.com/o/r/commit/commit1");
    });

    it("never forces the branch update", async () => {
      await run({ files: [{ path: "a.txt", content: "a" }] });

      expect(octokit.git.updateRef).toHaveBeenCalledWith({
        owner: "o",
        repo: "r",
        ref: "heads/feat/x",
        sha: "commit1",
        force: false,
      });
    });

    it("accepts deletions alone", async () => {
      const result = await run({ deletions: ["gone.txt"] });

      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain("Files changed: 0  Deleted: 1");
    });

    it("is marked destructive so it gates on approval by default", () => {
      expect(tool().destructive).toBe(true);
    });
  });

  describe("default branch", () => {
    it("refuses to commit to the default branch and points at create_branch", async () => {
      const result = await run({ branch: "main", files: [{ path: "a.txt", content: "a" }] });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Refusing to commit to "main", the default branch of o/r');
      expect(result.content).toContain("create_branch");
      expect(allGitCalls()).toBe(0);
    });

    it("refuses whatever the repository names as default, not only main", async () => {
      octokit.repos.get.mockResolvedValue({ data: { default_branch: "trunk" } });

      const result = await run({ branch: "trunk", deletions: ["a.txt"] });

      expect(result.is_error).toBe(true);
      expect(allGitCalls()).toBe(0);
    });
  });

  describe("GitHub errors", () => {
    it("hints at create_branch when the branch does not exist", async () => {
      octokit.git.getRef.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));

      const result = await run({ files: [{ path: "a.txt", content: "a" }] });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Branch "feat/x" not found in o/r');
      expect(result.content).toContain("create_branch");
      expect(octokit.git.createTree).not.toHaveBeenCalled();
    });

    it("says the branch moved and to retry when the update is not a fast-forward", async () => {
      octokit.git.updateRef.mockRejectedValue(
        Object.assign(new Error("Update is not a fast forward"), { status: 422 }),
      );

      const result = await run({ files: [{ path: "a.txt", content: "a" }] });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Branch "feat/x" moved');
      expect(result.content).toContain("Retry commit_files");
    });

    it("reports a failed tree write through the shared formatter", async () => {
      octokit.git.createTree.mockRejectedValue(
        Object.assign(new Error("tree.path contains a malformed path component"), { status: 422 }),
      );

      const result = await run({ files: [{ path: "a.txt", content: "a" }] });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain("validation failed for o/r");
      expect(octokit.git.updateRef).not.toHaveBeenCalled();
    });

    it("reports a missing repository through the shared formatter", async () => {
      octokit.repos.get.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));

      const result = await run({ files: [{ path: "a.txt", content: "a" }] });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain("Not found for o/r");
      expect(allGitCalls()).toBe(0);
    });
  });
});
