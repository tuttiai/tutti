/** Extract a short, human-readable error message from a Playwright error. */
export function pwErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Playwright errors often have verbose messages — take the first line
    const firstLine = error.message.split("\n")[0];
    return firstLine;
  }
  return String(error);
}
