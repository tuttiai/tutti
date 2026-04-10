/** Format a number with commas (e.g. 12345 → "12,345"). */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** Truncate a string to a max length, appending "..." if cut. */
export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + "...";
}

/** Extract a detailed error message from an Octokit error, including status code. */
export function ghErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const status = (error as { status?: number }).status;
    const statusPrefix = status ? `[${status}] ` : "";

    if (status === 401) return `${statusPrefix}Authentication failed. Check your GITHUB_TOKEN.`;
    if (status === 403) return `${statusPrefix}Forbidden — likely rate limited. Set GITHUB_TOKEN for higher limits (5000 req/hr).`;
    if (status === 404) return `${statusPrefix}Not found — check the owner/repo name, or the resource may be private.`;
    if (status === 422) return `${statusPrefix}Validation failed: ${error.message}`;

    return `${statusPrefix}${error.message}`;
  }
  return String(error);
}
