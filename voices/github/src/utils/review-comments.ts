import type { Octokit } from "@octokit/rest";

/** One comment on a line, or a range of lines, of a pull request's diff. */
export interface LineComment {
  path: string;
  line: number;
  start_line?: number | undefined;
  side: "LEFT" | "RIGHT";
  body: string;
}

/** Which comments GitHub will accept on the diff, and which must go in the review's body instead. */
export interface CommentPlan {
  inline: LineComment[];
  moved: LineComment[];
}

/** Inclusive line ranges a comment can attach to, one per hunk, for each side of one file's diff. */
type HunkRanges = Record<LineComment["side"], Array<[number, number]>>;

const HUNK_HEADER = /^@@ -([\d,]+) \+([\d,]+) @@/;

// "start,count" from a hunk header; GitHub leaves the count out when it is 1, and a count of
// 0 means the side has no lines in the hunk (a file added or deleted outright).
function addRange(into: Array<[number, number]>, spec: string): void {
  const [start = 0, count = 1] = spec.split(",").map(Number);
  if (count > 0) into.push([start, start + count - 1]);
}

/**
 * Read the hunk headers of one file's patch into the line ranges each side covers.
 *
 * GitHub accepts a review comment on any line inside a hunk, context lines included,
 * and refuses one anywhere else, so the headers are all that is needed.
 *
 * @param patch - The `patch` field of a pull request file.
 * @returns The covered ranges for the old (LEFT) and new (RIGHT) version of the file.
 */
export function hunkRanges(patch: string): HunkRanges {
  const ranges: HunkRanges = { LEFT: [], RIGHT: [] };
  for (const header of patch.split("\n")) {
    const match = HUNK_HEADER.exec(header);
    if (match === null) continue;
    addRange(ranges.LEFT, match[1] ?? "");
    addRange(ranges.RIGHT, match[2] ?? "");
  }
  return ranges;
}

/**
 * Whether a comment sits inside one hunk of its file's diff, its whole range included.
 *
 * @param comment - The comment to place.
 * @param ranges - The file's ranges from {@link hunkRanges}.
 * @returns True when GitHub will accept the comment on that line.
 */
export function fitsHunk(comment: LineComment, ranges: HunkRanges): boolean {
  const first = comment.start_line ?? comment.line;
  return ranges[comment.side].some(([from, to]) => first >= from && comment.line <= to);
}

/**
 * Sort comments into those that land on the pull request's diff and those that do not.
 *
 * A file whose patch GitHub leaves out (binary, or too large) takes no inline comment.
 * If the file list cannot be read every comment is tried inline, and the caller's
 * retry on GitHub's refusal is what catches a bad line.
 *
 * @param octokit - Authenticated Octokit client.
 * @param pr - The pull request.
 * @param comments - The comments the reviewer wrote.
 * @returns The comments split into inline and moved.
 */
export async function planComments(
  octokit: Octokit,
  pr: { owner: string; repo: string; pull_number: number },
  comments: LineComment[],
): Promise<CommentPlan> {
  let files: Array<{ filename: string; patch?: string | undefined }>;
  try {
    files = await octokit.paginate(octokit.pulls.listFiles, { ...pr, per_page: 100 });
  } catch {
    return { inline: comments, moved: [] };
  }
  const patches = new Map(files.map((f) => [f.filename, f.patch]));
  const plan: CommentPlan = { inline: [], moved: [] };
  for (const comment of comments) {
    const patch = patches.get(comment.path);
    const fits = patch !== undefined && fitsHunk(comment, hunkRanges(patch));
    (fits ? plan.inline : plan.moved).push(comment);
  }
  return plan;
}

/**
 * Append the comments that could not go on the diff to the review's body, so none is lost.
 *
 * @param body - The review's own text.
 * @param moved - The comments to append.
 * @returns The body, with a section listing each moved comment under its file and line.
 */
export function withMovedComments(body: string, moved: LineComment[]): string {
  if (moved.length === 0) return body;
  const items = moved.map((c) => {
    const where = c.start_line === undefined ? `line ${c.line}` : `lines ${c.start_line}-${c.line}`;
    return `**\`${c.path}\`, ${where}**\n\n${c.body}`;
  });
  return `${body}\n\n---\n\n**Comments not on a line this pull request changed**\n\n${items.join("\n\n")}`;
}
