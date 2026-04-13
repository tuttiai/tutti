import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

/** Result returned by every source loader. */
export interface LoadedSource {
  /** Raw bytes of the document. */
  buffer: Buffer;
  /** Filename (used for format detection) — derived from path or URL. */
  filename: string;
  /** MIME type if the loader knows it (HTTP sources), else undefined. */
  mime_type?: string;
}

/** Load a document from a local filesystem path. */
export async function loadFromFile(path: string): Promise<LoadedSource> {
  const resolved = resolve(path);
  // The dynamic path IS the contract — callers ingest arbitrary local
  // files. Path traversal is the caller's responsibility (sanitise before
  // passing in); we deliberately don't second-guess the resolved path here.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const buffer = await readFile(resolved);
  return { buffer, filename: basename(resolved) };
}
