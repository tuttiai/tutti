/** Small HTTP helpers for talking to the image the restart test runs. */

import { CHILD_API_KEY, type ImageProcess } from "./child.js";

const auth = { authorization: `Bearer ${CHILD_API_KEY}`, "content-type": "application/json" };

/** The ids from the stream's `approval_requested` frame. */
export interface Approval {
  interrupt_id: string;
  session_id: string;
}

function approvalIn(frame: string): Approval | undefined {
  const data = frame.split("\n").find((line) => line.startsWith("data: "));
  const parsed: unknown = data === undefined ? undefined : JSON.parse(data.slice(6));
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { event, interrupt_id, session_id } = parsed as Record<string, unknown>; // Safe: checked to be a non-null object.
  if (event !== "approval_requested") return undefined;
  return typeof interrupt_id === "string" && typeof session_id === "string" ? { interrupt_id, session_id } : undefined;
}

/**
 * Start a run on `/run/stream` and resolve once it asks for approval. The
 * stream is left open, as a client waiting on the reviewer would leave it.
 *
 * @param image - The running image.
 * @returns The approval's ids.
 */
export async function runUntilApproval(image: ImageProcess): Promise<Approval> {
  const res = await fetch(`${image.base}/run/stream`, { method: "POST", headers: auth, body: JSON.stringify({ input: "tidy up" }) });
  const reader = res.body?.getReader();
  if (!reader) throw new Error("no stream body");
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`stream ended before an approval: ${buffer}`);
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    const found = frames.map(approvalIn).find((a) => a !== undefined);
    if (found) {
      reader.cancel().catch(() => undefined);
      return found;
    }
  }
}

/**
 * Call the image's API.
 *
 * @param image - The running image.
 * @param method - `GET` or `POST`.
 * @param path - The route.
 * @param body - A JSON body for `POST`.
 * @returns The status and the parsed JSON body.
 */
export async function call(
  image: ImageProcess,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${image.base}${path}`, {
    method,
    headers: auth,
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  const json: unknown = await res.json();
  return { status: res.status, json: typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {} }; // Safe: checked to be a non-null object.
}
