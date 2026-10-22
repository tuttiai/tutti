/**
 * Build a ranked map of a repository's files and definitions, after
 * Aider's repo map: tag every file, link files by the names they share,
 * rank files with personalised PageRank, and show the best definitions
 * that fit a token budget.
 */

import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { logger } from "../logger.js";
import { TagCache } from "./cache.js";
import { listSourceFiles } from "./files.js";
import { buildGraph } from "./graph.js";
import type { Focus } from "./graph.js";
import { languageFor, looksBinary } from "./languages.js";
import { personalisedPageRank } from "./pagerank.js";
import { rankDefinitions } from "./rank.js";
import { renderMap } from "./render.js";
import { tagSource } from "./tagger.js";
import type { FileTags, TaggedFile } from "./types.js";

/** Default token budget for the map. */
export const DEFAULT_MAX_TOKENS = 1500;
/** Largest token budget a caller may ask for. */
export const MAX_TOKENS_CAP = 6000;
/** Most files read in one call. */
export const MAX_FILES = 5000;
/** Files larger than this are skipped. */
export const MAX_FILE_BYTES = 200 * 1024;
/** Time after which the map is rendered from what has been read. */
export const DEFAULT_TIME_BUDGET_MS = 20_000;

/** Options for {@link buildRepoMap}. */
export interface RepoMapOptions {
  /** Absolute directory to map. */
  dir: string;
  /** Directory git must not search above for a repository. Defaults to `dir`. */
  ceiling?: string;
  /** File paths (relative to `dir`) and identifiers to centre the map on. */
  focus?: readonly string[];
  /** Token budget, capped at {@link MAX_TOKENS_CAP}. */
  max_tokens?: number;
  /** Where to keep the tag cache. No cache when absent. */
  cache_dir?: string;
  /** Overrides {@link DEFAULT_TIME_BUDGET_MS}. */
  time_budget_ms?: number;
  /** Overrides {@link MAX_FILES}. */
  max_files?: number;
  /** Clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** The map and what went into it. */
export interface RepoMapResult {
  text: string;
  files_listed: number;
  files_tagged: number;
  cache_hits: number;
  definitions_total: number;
  timed_out: boolean;
}

interface Scan {
  tagged: TaggedFile[];
  /** Listed files the time limit stopped the scan before reaching. */
  unread: number;
}

async function tagFile(dir: string, path: string, cache: TagCache): Promise<FileTags | undefined> {
  const language = languageFor(path);
  const abs = join(dir, path);
  const st = await lstat(abs).catch(() => undefined);
  // Symbolic links are skipped: one could point outside the sandbox.
  if (!language || !st?.isFile() || st.size > MAX_FILE_BYTES) return undefined;
  const stamp = { mtimeMs: st.mtimeMs, size: st.size };
  const cached = cache.get(path, stamp);
  if (cached) return cached;
  const bytes = await readFile(abs);
  if (looksBinary(bytes)) return undefined;
  const tags = await tagSource(language, bytes.toString("utf-8"));
  cache.set(path, stamp, tags);
  return tags;
}

async function scan(opts: RepoMapOptions, files: readonly string[], cache: TagCache): Promise<Scan> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.time_budget_ms ?? DEFAULT_TIME_BUDGET_MS);
  const tagged: TaggedFile[] = [];
  for (const [i, path] of files.entries()) {
    if (now() > deadline) return { tagged, unread: files.length - i };
    const tags = await tagFile(opts.dir, path, cache);
    if (tags) tagged.push({ path, tags });
  }
  return { tagged, unread: 0 };
}

/**
 * Split focus entries into files and identifiers. An entry naming a
 * listed file (exactly, or as a path suffix) is a file; any other entry is
 * an identifier.
 */
function resolveFocus(entries: readonly string[], files: readonly string[]): Focus {
  const focusFiles = new Set<string>();
  const idents = new Set<string>();
  for (const raw of entries) {
    const entry = raw.replace(/^\.\//, "").replace(/\/+$/, "");
    const hits = files.filter((f) => f === entry || f.endsWith("/" + entry));
    hits.forEach((f) => focusFiles.add(f));
    if (hits.length === 0) idents.add(entry);
  }
  return { files: focusFiles, idents };
}

function personalisation(tagged: readonly TaggedFile[], focus: Focus): Map<string, number> {
  const p = new Map<string, number>();
  for (const f of tagged) {
    const definesFocus = f.tags.definitions.some((d) => focus.idents.has(d.name));
    if (focus.files.has(f.path) || definesFocus) p.set(f.path, 1);
  }
  return p;
}

function notes(unread: number, dropped: number): string[] {
  const out: string[] = [];
  if (unread > 0) out.push(`[Stopped at the time limit: ${unread} files were not read.]`);
  if (dropped > 0) out.push(`[Only the first ${MAX_FILES} files were read; ${dropped} more were skipped. Pass path to map a subdirectory.]`);
  return out;
}

/**
 * Build the repository map.
 *
 * @param opts - Directory, focus, budget, cache and limits.
 * @returns The rendered map and counts describing it.
 *
 * @example
 * const map = await buildRepoMap({ dir: "/tmp/repo", focus: ["src/run.ts"] });
 * console.info(map.text);
 */
export async function buildRepoMap(opts: RepoMapOptions): Promise<RepoMapResult> {
  const limit = opts.max_files ?? MAX_FILES;
  const listed = await listSourceFiles({ dir: opts.dir, ceiling: opts.ceiling ?? opts.dir, limit });
  const cache = await TagCache.open(opts.cache_dir, opts.dir);
  const { tagged, unread } = await scan(opts, listed.files, cache);
  await cache.save(new Set(listed.files)).catch((err: unknown) => {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "repo_map: tag cache not saved");
  });
  const focus = resolveFocus(opts.focus ?? [], listed.files);
  const graph = buildGraph(tagged, focus);
  const ranks = personalisedPageRank({
    nodes: tagged.map((f) => f.path),
    edges: graph.edges,
    personalisation: personalisation(tagged, focus),
  });
  const ranked = rankDefinitions(tagged, graph, { ranks, focus });
  const budget = Math.min(opts.max_tokens ?? DEFAULT_MAX_TOKENS, MAX_TOKENS_CAP);
  const text = renderMap(ranked, budget, {
    files: tagged.length,
    notes: notes(unread, listed.dropped),
  });
  return {
    text,
    files_listed: listed.files.length,
    files_tagged: tagged.length,
    cache_hits: cache.hits,
    definitions_total: ranked.length,
    timed_out: unread > 0,
  };
}
