/** Extract a short, human-readable error message from a Playwright error. */
export function pwErrorMessage(error: unknown, context?: string): string {
  const where = context ? ` (${context})` : "";
  if (error instanceof Error) {
    // Playwright errors often have verbose messages — take the first line
    const firstLine = error.message.split("\n")[0];
    return `Browser error${where}: ${firstLine}`;
  }
  return `Browser error${where}: ${String(error)}`;
}
