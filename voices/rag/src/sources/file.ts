import { readFile, realpath } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";

/** Result returned by every source loader. */
export interface LoadedSource {
  /** Raw bytes of the document. */
  buffer: Buffer;
  /** Filename (used for format detection) — derived from path or URL. */
  filename: string;
  /** MIME type if the loader knows it (HTTP sources), else undefined. */
  mime_type?: string;
}

/**
 * Trees a document never comes from, and which hold the process itself:
 * `/proc/self/environ` is every credential the process was started with, and
 * an ingested file is embedded by a third party and returned by search.
 */
const SYSTEM_TREES = ["/proc", "/sys", "/dev"];

/** Whether a resolved path is one of {@link SYSTEM_TREES} or inside one. */
function inSystemTree(path: string): boolean {
  return SYSTEM_TREES.some((tree) => path === tree || path.startsWith(tree + sep));
}

/** Refuse a path in one of {@link SYSTEM_TREES}. */
function refuseSystemTree(path: string): void {
  if (inSystemTree(path)) {
    throw new Error(`Refusing to ingest ${path}: /proc, /sys and /dev hold the process's own state, not documents.`);
  }
}

/**
 * Load a document from a local filesystem path.
 *
 * Any readable file is accepted except the process's own state. The path is
 * checked after symlinks are followed, so a link pointing into `/proc` is
 * refused like the path itself.
 *
 * @throws {Error} When the path is, or resolves into, `/proc`, `/sys` or `/dev`.
 */
export async function loadFromFile(path: string): Promise<LoadedSource> {
  const resolved = resolve(path);
  refuseSystemTree(resolved);
  const real = await realpath(resolved);
  refuseSystemTree(real);
  const buffer = await readFile(real);
  return { buffer, filename: basename(resolved) };
}
