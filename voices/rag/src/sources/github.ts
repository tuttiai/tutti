import type { LoadedSource } from "./file.js";
import { loadFromUrl } from "./url.js";

// Matches https://github.com/{owner}/{repo}/blob/{ref}/{path...}
const BLOB_RE =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i;

// Matches https://github.com/{owner}/{repo}[/] (no sub-path)
const REPO_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/i;

/** True when `url` points to github.com. */
export function isGitHubUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "github.com" || host === "raw.githubusercontent.com";
  } catch {
    return false;
  }
}

/**
 * Rewrite a GitHub blob URL to its `raw.githubusercontent.com` counterpart.
 *
 * Bare repo URLs (no file path) throw — full-repo ingestion is not yet
 * supported to avoid pulling in a tar/zip extractor.
 */
export function toRawUrl(url: string): string {
  if (url.includes("raw.githubusercontent.com")) return url;

  const blob = BLOB_RE.exec(url);
  if (blob) {
    const [, owner, repo, ref, path] = blob;
    return (
      "https://raw.githubusercontent.com/" +
      owner +
      "/" +
      repo +
      "/" +
      ref +
      "/" +
      path
    );
  }

  if (REPO_RE.test(url)) {
    throw new Error(
      "Full-repo ingestion is not supported — pass a specific file URL " +
        "(github.com/owner/repo/blob/<ref>/<path>)",
    );
  }

  throw new Error("Unrecognized GitHub URL: " + url);
}

/** Fetch a single file from GitHub via `raw.githubusercontent.com`. */
export async function loadFromGitHub(url: string): Promise<LoadedSource> {
  return loadFromUrl(toRawUrl(url));
}
