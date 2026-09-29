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
  describe("refusals before any git request", () => {
    it.each([
      ["traversal", { files: [{ path: "../escape.txt", content: "x" }] }, "Invalid path"],
      ["absolute", { files: [{ path: "/etc/passwd", content: "x" }] }, "Invalid path"],
      ["backslash", { files: [{ path: "a\\b.txt", content: "x" }] }, "Invalid path"],
      ["empty segment", { deletions: ["a//b.txt"] }, "Invalid path"],
      [".git", { files: [{ path: ".git/hooks/post-checkout", content: "x" }] }, "Invalid path"],
      ["duplicate", { files: [{ path: "a.txt", content: "x" }], deletions: ["a.txt"] }, "Duplicate path"],
      ["empty", {}, "Nothing to commit"],
      ["over 1 MB", { files: [{ path: "big.txt", content: "a".repeat(1024 * 1024 + 1) }] }, "1 MB"],
    ])("refuses %s", async (_label, input, expected) => {
      const result = await run(input);

      expect(result.is_error).toBe(true);
      expect(result.content).toContain(expected);
      expect(octokit.repos.get).not.toHaveBeenCalled();
      expect(allGitCalls()).toBe(0);
    });

    it("refuses more than 100 entries across files and deletions", async () => {
      const files = Array.from({ length: 50 }, (_, i) => ({ path: `f${i}.txt`, content: "x" }));
      const deletions = Array.from({ length: 51 }, (_, i) => `d${i}.txt`);

      const result = await run({ files, deletions });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain("Too many entries: 101");
      expect(allGitCalls()).toBe(0);
    });

    it("rejects more than 100 files at the schema", () => {
      const files = Array.from({ length: 101 }, (_, i) => ({ path: `f${i}.txt`, content: "x" }));
      expect(() =>
        tool().parameters.parse({ owner: "o", repo: "r", branch: "b", message: "m", files }),
      ).toThrow();
    });
  });
});
