/** Format a number with commas (e.g. 12345 → "12,345"). */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** Truncate a string to a max length, appending "..." if cut. */
export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + "...";
}

/** Extract a short error message from an Octokit error. */
export function ghErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message;
    // Octokit errors often include JSON in the message
    if (msg.includes(" - ")) {
      return msg.split(" - ").slice(1).join(" - ");
    }
    return msg;
  }
  return String(error);
}
