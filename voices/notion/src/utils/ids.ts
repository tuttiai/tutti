import { z } from "zod";

const BARE_ID = /^[0-9a-f]{32}$/i;
const DASHED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The id a Notion link ends in, after the slug of the title: `My-Page-<32 hex>`. */
const TRAILING_ID = /([0-9a-f]{32})$/i;
const NOTION_HOSTS = ["notion.so", "notion.site"];

/** Put 32 hex characters into the dashed, lower-case form Notion itself answers with. */
function dashed(hex: string): string {
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Whether a hostname is Notion's own, including a workspace subdomain. */
function isNotionHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return NOTION_HOSTS.some((root) => host === root || host.endsWith(`.${root}`));
}

/** The id at the end of a notion.so or notion.site link's path, if it has one. */
function idFromUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || !isNotionHost(url.hostname)) return undefined;
  const last = url.pathname.split("/").filter((segment) => segment.length > 0).at(-1) ?? "";
  // Dropping every dash reads a slug-then-bare-id and a slug-then-dashed-id the same way.
  const match = TRAILING_ID.exec(last.replaceAll("-", ""))?.[1];
  return match === undefined ? undefined : dashed(match);
}

/**
 * Turn what a person or model calls a Notion page, database or block into the id Notion reads.
 *
 * Accepts 32 hex characters with or without dashes, or an `https` link on notion.so or
 * notion.site whose path ends in one. Anything else is refused rather than guessed at, so a
 * stray path segment can never reach the API.
 *
 * @param value - The id or link as given.
 * @returns The dashed, lower-case id, or `undefined` when there is none to find.
 *
 * @example
 * normaliseNotionId("https://www.notion.so/acme/Roadmap-0123456789abcdef0123456789abcdef");
 * // "01234567-89ab-cdef-0123-456789abcdef"
 */
export function normaliseNotionId(value: string): string | undefined {
  const trimmed = value.trim();
  if (BARE_ID.test(trimmed)) return dashed(trimmed);
  if (DASHED_ID.test(trimmed)) return dashed(trimmed.replaceAll("-", ""));
  return idFromUrl(trimmed);
}

/**
 * A tool parameter holding a Notion id or link, validated and normalised before any request.
 *
 * @param what - What the id names, for the parameter's description and the refusal.
 * @returns The zod schema, whose parsed value is the dashed id.
 */
export function notionIdSchema(what: string): z.ZodType<string, z.ZodTypeDef, string> {
  return z
    .string()
    .min(1)
    .max(2_000)
    .transform((value, ctx) => {
      const id = normaliseNotionId(value);
      if (id !== undefined) return id;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Not a Notion ${what} id. Pass the 32-character id, with or without dashes, or the page's notion.so link.`,
      });
      return z.NEVER;
    })
    .describe(`The ${what}'s Notion id (32 hex characters, dashes optional) or its notion.so link.`);
}
