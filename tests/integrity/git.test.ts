import { describe, expect, it } from "vitest";
import { GitError, gitOk, isShallow, resolveCommit } from "../../scripts/integrity/git.js";
import { fakeGit, sha } from "./fake-git.js";

describe("gitOk", () => {
  it("returns stdout on exit 0", async () => {
    const { git } = fakeGit({ "rev-list --merges": "abc\n" });
    await expect(gitOk(git, ["rev-list", "--merges"])).resolves.toBe("abc\n");
  });

  it("throws a GitError naming only the subcommand and code, never git's output", async () => {
    const { git } = fakeGit({ "rev-list --merges": { code: 128, stdout: "SECRET-OUTPUT" } });
    const error: unknown = await gitOk(git, ["rev-list", "--merges"]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitError);
    expect(error).toMatchObject({ subcommand: "rev-list", code: 128, message: "git rev-list exited 128" });
  });

  it("names an empty subcommand when called with no arguments", async () => {
    const { git } = fakeGit({ "": { code: 1, stdout: "" } });
    await expect(gitOk(git, [])).rejects.toMatchObject({ subcommand: "" });
  });
});

describe("isShallow", () => {
  it("reads git's true or false", async () => {
    await expect(isShallow(fakeGit({ "rev-parse --is-shallow-repository": "true\n" }).git)).resolves.toBe(true);
    await expect(isShallow(fakeGit({ "rev-parse --is-shallow-repository": "false\n" }).git)).resolves.toBe(false);
  });
});

describe("resolveCommit", () => {
  const key = "rev-parse --verify --quiet --end-of-options main^{commit}";

  it("returns the full SHA, the ref placed after --end-of-options", async () => {
    await expect(resolveCommit(fakeGit({ [key]: `${sha("a")}\n` }).git, "main")).resolves.toBe(sha("a"));
  });

  it("returns null when the ref names no commit", async () => {
    await expect(resolveCommit(fakeGit({ [key]: { code: 1, stdout: "" } }).git, "main")).resolves.toBeNull();
  });
});
