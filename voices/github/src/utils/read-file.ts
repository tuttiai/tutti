import type { Octokit } from "@octokit/rest";

/** Where a file is read from. `ref` is a branch, tag or commit SHA; absent means the default branch. */
export interface FileAddress {
  owner: string;
  repo: string;
  path: string;
  ref?: string | undefined;
}

/** A directory's entries, a file's whole text, or something that is neither. */
export type FileRead =
  | { kind: "directory"; entries: Array<{ name: string; type: string }> }
  | { kind: "file"; text: string; bytes: number }
  | { kind: "other"; type: string };

/**
 * Read a whole file as UTF-8 text through the GitHub API.
 *
 * The contents endpoint inlines a file only up to 1 MB; above that it answers
 * with `encoding: "none"` and no content, so the text is fetched as a blob by
 * its SHA instead (blobs go to 100 MB). Either way the caller gets the whole
 * file, never a silently shortened one.
 *
 * @param octokit - Authenticated Octokit client.
 * @param address - Owner, repo, path and optional ref.
 * @returns What is at the path. Octokit errors propagate to the caller.
 */
export async function readRepoFile(octokit: Octokit, address: FileAddress): Promise<FileRead> {
  const { owner, repo, path, ref } = address;
  const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
  if (Array.isArray(data)) {
    return { kind: "directory", entries: data.map((e) => ({ name: e.name, type: e.type })) };
  }
  if (data.type !== "file" || !("content" in data)) return { kind: "other", type: data.type };
  let base64 = data.content;
  if (data.encoding === "none" || (base64 === "" && data.size > 0)) {
    const { data: blob } = await octokit.git.getBlob({ owner, repo, file_sha: data.sha });
    base64 = blob.content;
  }
  const buffer = Buffer.from(base64, "base64");
  return { kind: "file", text: buffer.toString("utf-8"), bytes: buffer.length };
}
