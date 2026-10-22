/**
 * Parsed tags kept on disk between calls, one JSON file per mapped
 * directory, keyed by path and invalidated by modification time and size.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { FileTagsSchema } from "./types.js";
import type { FileTags } from "./types.js";

const CACHE_VERSION = 1;

const EntrySchema = z.object({
  mtimeMs: z.number(),
  size: z.number(),
  tags: FileTagsSchema,
});

const CacheFileSchema = z.object({
  version: z.literal(CACHE_VERSION),
  entries: z.record(z.string(), EntrySchema),
});

type Entry = z.infer<typeof EntrySchema>;

/** What identifies a file's version for the cache. */
export interface FileStamp {
  mtimeMs: number;
  size: number;
}

/**
 * Tag cache for one mapped directory. Read it with {@link TagCache.open},
 * look files up with {@link TagCache.get}, and {@link TagCache.save} at the
 * end; entries for files no longer listed are dropped on save.
 */
export class TagCache {
  /** Lookups answered from the cache in this run. */
  hits = 0;
  private readonly fresh = new Map<string, Entry>();

  private constructor(
    private readonly file: string | undefined,
    private readonly stored: ReadonlyMap<string, Entry>,
  ) {}

  /**
   * Open the cache for a directory.
   *
   * @param cacheDir - Where cache files live, or `undefined` for no cache.
   * @param mappedDir - The directory being mapped; names the cache file.
   * @returns The cache, empty when there is none yet or it is unreadable.
   */
  static async open(cacheDir: string | undefined, mappedDir: string): Promise<TagCache> {
    if (!cacheDir) return new TagCache(undefined, new Map());
    const id = createHash("sha256").update(mappedDir).digest("hex").slice(0, 16);
    const file = join(cacheDir, `tags-v${CACHE_VERSION}-${id}.json`);
    try {
      const parsed = CacheFileSchema.safeParse(JSON.parse(await readFile(file, "utf-8")));
      return new TagCache(file, new Map(parsed.success ? Object.entries(parsed.data.entries) : []));
    } catch {
      return new TagCache(file, new Map());
    }
  }

  /**
   * Cached tags for a file, if its stamp still matches.
   *
   * @param path - Path relative to the mapped directory.
   * @param stamp - The file's current modification time and size.
   */
  get(path: string, stamp: FileStamp): FileTags | undefined {
    const entry = this.stored.get(path);
    if (!entry || entry.mtimeMs !== stamp.mtimeMs || entry.size !== stamp.size) return undefined;
    this.hits++;
    this.fresh.set(path, entry);
    return entry.tags;
  }

  /**
   * Record a file's tags for the next run.
   *
   * @param path - Path relative to the mapped directory.
   * @param stamp - The stamp the tags were read at.
   * @param tags - The tags.
   */
  set(path: string, stamp: FileStamp, tags: FileTags): void {
    this.fresh.set(path, { mtimeMs: stamp.mtimeMs, size: stamp.size, tags });
  }

  /**
   * Write the cache, through a temporary file renamed into place.
   *
   * @param listed - Every file listed this run. Stored entries for these
   *                 are kept even when a time limit stopped the run before
   *                 reaching them; entries for any other path are dropped.
   */
  async save(listed: ReadonlySet<string>): Promise<void> {
    if (!this.file) return;
    for (const [path, entry] of this.stored) {
      if (listed.has(path) && !this.fresh.has(path)) this.fresh.set(path, entry);
    }
    const dir = join(this.file, "..");
    await mkdir(dir, { recursive: true });
    // The cache sits inside the sandbox, which may itself be the repository:
    // a `*` .gitignore keeps the directory out of `git status`.
    await writeFile(join(dir, ".gitignore"), "*\n", "utf-8");
    const body = { version: CACHE_VERSION, entries: Object.fromEntries(this.fresh) };
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(body), "utf-8");
    await rename(tmp, this.file);
  }
}
