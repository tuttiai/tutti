import { basename } from "node:path";
import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "./embeddings/types.js";
import type { SearchEngine } from "./search.js";
import type { VectorStore } from "./stores/types.js";
import type { RagConfig } from "./types.js";

/**
 * Everything the four RAG tools need at runtime. Built once by
 * {@link RagVoice} and shared across all tool invocations so repeated
 * lookups don't rebuild the engine.
 */
export interface RagContext {
  config: RagConfig;
  embeddings: EmbeddingProvider;
  store: VectorStore;
  engine: SearchEngine;
}

/** True when `source` starts with `http://` or `https://`. */
export function isUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

/**
 * Derive a stable, human-readable identifier from a source string.
 *
 * - For URLs: the last non-empty path segment plus a short hash, so two
 *   different `README.md` files on different hosts don't collide.
 * - For paths: the basename plus a short hash of the full path.
 */
export function deriveSourceId(source: string): string {
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 8);
  const stem = extractStem(source);
  return stem ? stem + "-" + hash : hash;
}

/** Extract a display filename for a source string. */
export function filenameFor(source: string): string {
  return extractStem(source) ?? source;
}

function extractStem(source: string): string | undefined {
  if (isUrl(source)) {
    try {
      const { pathname, hostname } = new URL(source);
      const seg = basename(pathname);
      return seg || hostname;
    } catch {
      return undefined;
    }
  }
  const seg = basename(source);
  return seg || undefined;
}
