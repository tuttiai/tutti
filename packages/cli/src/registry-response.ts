/**
 * Validation of the voice registry response that `tutti-ai search` and
 * `tutti-ai voices` fetch from tuttiai/voices.
 *
 * @remarks
 * `@tuttiai/cli` does not declare zod, so the response is checked with a
 * hand-written guard rather than a schema. Error strings name a path and
 * a rule only, never a value from the payload, so they are safe to log.
 */

/** Size limits applied to the registry response. */
export const REGISTRY_LIMITS = {
  official: 500,
  community: 500,
  tags: 20,
  tag: 50,
  name: 64,
  package: 214,
  description: 500,
  toolsCount: 1000,
  toolsCountText: 32,
} as const;

/** One voice as the registry lists it. Unknown keys are dropped. */
export interface RegistryEntry {
  name: string;
  package: string;
  description: string;
  tags: string[];
  /** A tool count, or a word such as `"dynamic"` for voices whose tools vary. */
  tools_count?: number | string;
}

/** The registry's two voice lists after validation. */
export interface RegistryResponse {
  official: RegistryEntry[];
  community: RegistryEntry[];
}

/** Outcome of validating the registry, shaped like zod's `safeParse`. */
export type RegistryParseResult =
  | { success: true; data: RegistryResponse }
  | { success: false; error: string };

type ListKey = "official" | "community";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function isTags(value: unknown): value is string[] {
  if (!isArray(value) || value.length > REGISTRY_LIMITS.tags) return false;
  return value.every((tag) => isText(tag, REGISTRY_LIMITS.tag));
}

function isToolsCount(value: unknown): value is number | string | undefined {
  if (value === undefined || isText(value, REGISTRY_LIMITS.toolsCountText)) return true;
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= REGISTRY_LIMITS.toolsCount
  );
}

function textRule(path: string, max: number): string {
  return `${path}: expected a string of at most ${max} characters`;
}

function parseEntry(value: unknown, path: string): RegistryEntry | string {
  if (!isRecord(value)) return `${path}: expected an object`;
  const { name, package: pkg, description, tags, tools_count } = value;
  const limits = REGISTRY_LIMITS;
  if (!isText(name, limits.name)) return textRule(`${path}.name`, limits.name);
  if (!isText(pkg, limits.package)) return textRule(`${path}.package`, limits.package);
  if (!isText(description, limits.description)) {
    return textRule(`${path}.description`, limits.description);
  }
  if (!isTags(tags)) {
    return `${path}.tags: expected at most ${limits.tags} strings of at most ${limits.tag} characters`;
  }
  if (!isToolsCount(tools_count)) {
    return `${path}.tools_count: expected an integer from 0 to ${limits.toolsCount} or a string of at most ${limits.toolsCountText} characters`;
  }
  const entry: RegistryEntry = { name, package: pkg, description, tags };
  if (tools_count !== undefined) entry.tools_count = tools_count;
  return entry;
}

function parseList(value: unknown, key: ListKey): RegistryEntry[] | string {
  if (value === undefined) return [];
  if (!isArray(value)) return `${key}: expected an array`;
  const max = key === "official" ? REGISTRY_LIMITS.official : REGISTRY_LIMITS.community;
  if (value.length > max) return `${key}: expected at most ${max} items`;
  const entries: RegistryEntry[] = [];
  for (const [index, item] of value.entries()) {
    const entry = parseEntry(item, `${key}[${index}]`);
    if (typeof entry === "string") return entry;
    entries.push(entry);
  }
  return entries;
}

/**
 * Validate a decoded registry payload.
 *
 * One invalid entry or one exceeded limit rejects the whole payload. Unknown
 * keys, such as `$schema`, `repo` or `version`, are ignored. A missing list
 * counts as empty, but at least one of `official` and `community` must exist.
 *
 * @param data - The decoded JSON body, not yet trusted.
 * @returns The two lists, or an error that names a path and a rule.
 */
export function parseRegistryResponse(data: unknown): RegistryParseResult {
  if (!isRecord(data)) return { success: false, error: "(root): expected an object" };
  const { official: rawOfficial, community: rawCommunity } = data;
  if (rawOfficial === undefined && rawCommunity === undefined) {
    return { success: false, error: "(root): expected official or community" };
  }
  const official = parseList(rawOfficial, "official");
  if (typeof official === "string") return { success: false, error: official };
  const community = parseList(rawCommunity, "community");
  if (typeof community === "string") return { success: false, error: community };
  return { success: true, data: { official, community } };
}

/**
 * Decode and validate a raw registry body.
 *
 * @param body - The response text as received.
 * @returns As {@link parseRegistryResponse}, with the error `invalid-json`
 * when the body is not JSON.
 */
export function parseRegistryBody(body: string): RegistryParseResult {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return { success: false, error: "invalid-json" };
  }
  return parseRegistryResponse(data);
}
