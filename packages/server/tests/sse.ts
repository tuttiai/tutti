/** Parse raw SSE text into an array of event objects. */
export function parseSSE(raw: string): Record<string, unknown>[] {
  return raw
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => {
      const dataLine = frame
        .split("\n")
        .find((l) => l.startsWith("data: "));
      if (!dataLine) return undefined;
      // JSON.parse returns `any`; every frame the route writes is an object.
      return JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
    })
    .filter((e): e is Record<string, unknown> => e !== undefined);
}
