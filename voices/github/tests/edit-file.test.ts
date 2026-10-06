import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Octokit } from "@octokit/rest";
import type { ToolContext } from "@tuttiai/types";
import { createEditFileTool } from "../src/tools/edit-file.js";
import { applyEdits } from "../src/utils/text-edits.js";

const ctx: ToolContext = { session_id: "test", agent_name: "test" };

const FILE = "export const a = 1;\nexport const b = 2;\n";

// Mock Octokit: only the methods edit_file calls.
function createMockOctokit() {
  return {
    repos: { get: vi.fn(), getContent: vi.fn() },
    git: {
      getRef: vi.fn(),
      getCommit: vi.fn(),
      getBlob: vi.fn(),
      createTree: vi.fn(),
      createCommit: vi.fn(),
      updateRef: vi.fn(),
    },
  };
}

let octokit: ReturnType<typeof createMockOctokit>;

function tool() {
  // Safe: the tool only touches the methods the mock defines above.
  return createEditFileTool(octokit as unknown as Octokit);
}

function run(input: Record<string, unknown>) {
  const t = tool();
  return t.execute(
    t.parameters.parse({
      owner: "o",
      repo: "r",
      branch: "feat/x",
      path: "src/a.ts",
      message: "Change b",
      edits: [{ old_text: "b = 2", new_text: "b = 3" }],
      ...input,
    }),
    ctx,
  );
}

beforeEach(() => {
  octokit = createMockOctokit();
  octokit.repos.get.mockResolvedValue({ data: { default_branch: "main" } });
  octokit.repos.getContent.mockResolvedValue({
    data: { type: "file", content: Buffer.from(FILE).toString("base64"), encoding: "base64", size: FILE.length, sha: "f1" },
  });
  octokit.git.getRef.mockResolvedValue({ data: { object: { sha: "head1" } } });
  octokit.git.getCommit.mockResolvedValue({ data: { tree: { sha: "tree0" } } });
  octokit.git.createTree.mockResolvedValue({ data: { sha: "tree1" } });
  octokit.git.createCommit.mockResolvedValue({ data: { sha: "c1", html_url: "https://github.com/o/r/commit/c1" } });
  octokit.git.updateRef.mockResolvedValue({ data: {} });
});

describe("applyEdits", () => {
  it("applies edits in order, each to the previous result", () => {
    const out = applyEdits("one two", [
      { old_text: "one", new_text: "three" },
      { old_text: "three two", new_text: "done" },
    ]);
    expect(out).toEqual({ ok: true, text: "done" });
  });

  it("refuses text that is missing, repeated, or unchanged", () => {
    expect(applyEdits("abc", [{ old_text: "z", new_text: "y" }])).toMatchObject({ ok: false, problem: expect.stringContaining("not found") });
    expect(applyEdits("aa", [{ old_text: "a", new_text: "b" }])).toMatchObject({ ok: false, problem: expect.stringContaining("occurs 2 times") });
    expect(applyEdits("a", [{ old_text: "a", new_text: "a" }])).toMatchObject({ ok: false, problem: expect.stringContaining("the same") });
  });
});

describe("edit_file", () => {
  it("reads the file at the head SHA, edits it whole, and fast-forwards the branch", async () => {
    const result = await run({});

    expect(result.is_error).toBeUndefined();
    expect(octokit.repos.getContent).toHaveBeenCalledWith({ owner: "o", repo: "r", path: "src/a.ts", ref: "head1" });
    expect(octokit.git.createTree).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      base_tree: "tree0",
      tree: [{ path: "src/a.ts", mode: "100644", type: "blob", content: "export const a = 1;\nexport const b = 3;\n" }],
    });
    expect(octokit.git.createCommit).toHaveBeenCalledWith({ owner: "o", repo: "r", message: "Change b", tree: "tree1", parents: ["head1"] });
    expect(octokit.git.updateRef).toHaveBeenCalledWith({ owner: "o", repo: "r", ref: "heads/feat/x", sha: "c1", force: false });
    expect(result.content).toContain("Edited src/a.ts on branch feat/x in o/r (1 replacement(s))");
    expect(result.content).toContain("Commit: c1");
  });

  it("is marked destructive so it gates on approval by default", () => {
    expect(tool().destructive).toBe(true);
  });

  it("refuses the default branch before reading anything", async () => {
    const result = await run({ branch: "main" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Refusing to commit to "main"');
    expect(octokit.git.getRef).not.toHaveBeenCalled();
  });

  it("refuses an unsafe path before any request", async () => {
    const result = await run({ path: "../etc/passwd" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("'.' and '..' segments are not allowed");
    expect(octokit.repos.get).not.toHaveBeenCalled();
  });

  it("commits nothing when an old_text is missing", async () => {
    const result = await run({ edits: [{ old_text: "c = 9", new_text: "c = 1" }] });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Nothing was committed. Edit 1");
    expect(octokit.git.createTree).not.toHaveBeenCalled();
  });

  it("commits nothing when an old_text is not unique", async () => {
    const result = await run({ edits: [{ old_text: "export const", new_text: "const" }] });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("occurs 2 times");
    expect(octokit.git.updateRef).not.toHaveBeenCalled();
  });

  it("refuses a directory", async () => {
    octokit.repos.getContent.mockResolvedValue({ data: [{ name: "x", type: "file" }] });
    const result = await run({});
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("is not a file");
  });

  it("refuses an edit that would push the file over 1 MB", async () => {
    const result = await run({ edits: [{ old_text: "b = 2", new_text: "x".repeat(1024 * 1024) }] });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("at most 1048576 bytes");
  });

  it("explains a missing branch, a missing file and a branch that moved", async () => {
    octokit.git.getRef.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }));
    expect((await run({})).content).toContain('Branch "feat/x" not found');

    octokit.repos.getContent.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }));
    expect((await run({})).content).toContain('File "src/a.ts" not found on branch "feat/x"');

    octokit.git.updateRef.mockRejectedValueOnce(Object.assign(new Error("Update is not a fast forward"), { status: 422 }));
    expect((await run({})).content).toContain("never force-updated");
  });

  it("rejects an empty edit list in the schema", () => {
    expect(() => tool().parameters.parse({ owner: "o", repo: "r", branch: "b", path: "p", message: "m", edits: [] })).toThrow();
  });
});
