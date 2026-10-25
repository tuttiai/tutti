import { isRecord } from "../client.js";

/** Truncate a string to a max length, appending "..." if cut. */
export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + "...";
}

/** The `data` payload of a Sender response, as an object. */
export function dataOf(body: unknown): Record<string, unknown> {
  if (isRecord(body) && isRecord(body["data"])) return body["data"];
  return {};
}

/** The `data` array of a Sender list response. */
export function listOf(body: unknown): Record<string, unknown>[] {
  if (isRecord(body) && Array.isArray(body["data"])) return body["data"].filter(isRecord);
  if (isRecord(body) && isRecord(body["data"])) return [body["data"]];
  return [];
}

/** Read a string field, or an empty string. */
export function str(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" || typeof v === "number" ? String(v) : "";
}

/** "page 1 of 3, 25 total" from a Sender `meta` block, or an empty string. */
export function pageSummary(body: unknown): string {
  if (!isRecord(body) || !isRecord(body["meta"])) return "";
  const m = body["meta"];
  const cur = m["current_page"];
  const last = m["last_page"];
  const total = m["total"];
  if (typeof cur !== "number" || typeof last !== "number") return "";
  const more = cur < last ? `; pass page=${cur + 1} for more` : "";
  return `page ${cur} of ${last}${typeof total === "number" ? `, ${total} total` : ""}${more}`;
}

/** One-line summary of a subscriber object. */
export function subscriberLine(s: Record<string, unknown>): string {
  const name = [str(s, "firstname"), str(s, "lastname")].filter(Boolean).join(" ");
  const status = isRecord(s["status"]) ? str(s["status"], "email") : "";
  const tags = Array.isArray(s["subscriber_tags"])
    ? s["subscriber_tags"].filter(isRecord).map((t) => str(t, "title")).filter(Boolean)
    : [];
  return [
    `${str(s, "id")} · ${str(s, "email") || "(no email)"}`,
    name ? ` · ${name}` : "",
    status ? ` · ${status}` : "",
    tags.length ? ` · groups: ${tags.join(", ")}` : "",
  ].join("");
}

/** One-line summary of a campaign object. */
export function campaignLine(c: Record<string, unknown>): string {
  const title = str(c, "title");
  return `${str(c, "id")} · ${str(c, "status") || "unknown"} · ${truncate(str(c, "subject"), 80)}${title ? ` · "${truncate(title, 60)}"` : ""}`;
}
