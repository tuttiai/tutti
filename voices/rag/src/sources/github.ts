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
 *
 * Host matching uses parsed `URL.hostname` rather than a substring check —
 * `url.includes("raw.githubusercontent.com")` would be bypassable via
 * `https://evil.com/raw.githubusercontent.com/...`,
 * `https://raw.githubusercontent.com.evil.com/...`, or any URL carrying
 * that substring anywhere in its path or query.
 */
export function toRawUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Unrecognized GitHub URL: " + url);
  }
  const host = parsed.hostname.toLowerCase();

  // Already a raw URL — pass through unchanged.
  if (host === "raw.githubusercontent.com") return url;

  // Everything below expects a github.com URL. Anything else — including
  // subdomains like `foo.github.com` or lookalikes like `github.com.evil.com`
  // — is rejected up-front.
  if (host !== "github.com") {
    throw new Error("Unrecognized GitHub URL: " + url);
  }

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
