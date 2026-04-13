import { detectFormat, parseBuffer } from "./parsers/index.js";
import { chunkText } from "./chunking.js";
import { loadFromFile, type LoadedSource } from "./sources/file.js";
import { loadFromGitHub, isGitHubUrl } from "./sources/github.js";
import { loadFromUrl } from "./sources/url.js";
import {
  type Chunk,
  type ChunkOptions,
  ChunkStrategy,
  type IngestSourceInput,
} from "./types.js";

export type { Chunk, ChunkOptions, IngestSourceInput } from "./types.js";
export { ChunkStrategy } from "./types.js";

/**
 * Load a single source document (local path, remote URL, or GitHub URL)
 * and normalise it to a {@link LoadedSource}.
 */
export async function loadSource(
  input: IngestSourceInput,
): Promise<LoadedSource> {
  if (input.path && input.url) {
    throw new Error("IngestSourceInput: set exactly one of `path` or `url`");
  }
  if (input.path) return loadFromFile(input.path);
  if (input.url) {
    return isGitHubUrl(input.url)
      ? loadFromGitHub(input.url)
      : loadFromUrl(input.url);
  }
  throw new Error("IngestSourceInput: one of `path` or `url` is required");
}

/**
 * Ingest one document end-to-end: load, parse, chunk, and return
 * {@link Chunk} records ready to be embedded.
 *
 * Embedding is intentionally out of scope — callers feed the returned
 * chunks into their embedder of choice.
 *
 * @example
 * const chunks = await ingestDocument(
 *   { source_id: "docs/readme", path: "./README.md" },
 *   { strategy: ChunkStrategy.Paragraph },
 * );
 */
export async function ingestDocument(
  input: IngestSourceInput,
  options: ChunkOptions = {},
): Promise<Chunk[]> {
  const loaded = await loadSource(input);

  const format = detectFormat({
    mime_type: input.mime_type ?? loaded.mime_type,
    filename: loaded.filename,
  });

  const text = await parseBuffer(loaded.buffer, format);
  const strategy = options.strategy ?? ChunkStrategy.Fixed;
  const pieces = chunkText(text, options);

  return pieces.map((piece, index) => ({
    text: piece,
    source_id: input.source_id,
    chunk_index: index,
    metadata: {
      ...input.metadata,
      format,
      strategy,
      ...(input.title ? { title: input.title } : {}),
    },
  }));
}
