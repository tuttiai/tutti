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
export function ghErrorMessage(error: unknown, context?: string): string {
  const where = context ? ` for ${context}` : "";
  if (error instanceof Error) {
    const status = (error as { status?: number }).status;
    const statusPrefix = status ? `[${status}] ` : "";

    if (status === 401)
      return `${statusPrefix}GitHub authentication failed${where}.\nCheck that GITHUB_TOKEN is set correctly in your .env file.`;
    if (status === 403)
      return `${statusPrefix}GitHub API forbidden${where} — likely rate limited.\nSet GITHUB_TOKEN for higher limits (5000 req/hr).`;
    if (status === 404)
      return `${statusPrefix}Not found${where}.\nCheck the owner/repo name is correct, or the resource may be private.`;
    if (status === 422)
      return `${statusPrefix}GitHub validation failed${where}: ${error.message}`;

    return `${statusPrefix}GitHub API error${where}: ${error.message}`;
  }
  return String(error);
}
