import { type ChunkOptions, ChunkStrategy } from "./types.js";

const DEFAULT_CHUNK_SIZE = 512;
const DEFAULT_OVERLAP_RATIO = 0.2;
const MAX_OVERLAP_RATIO = 0.9;

/**
 * Split `text` into an array of chunk strings using the given strategy.
 *
 * Callers wrap each string with source metadata to produce the final
 * {@link Chunk} records.
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const strategy = options.strategy ?? ChunkStrategy.Fixed;
  const trimmed = text.trim();
  if (!trimmed) return [];

  switch (strategy) {
    case ChunkStrategy.Fixed:
      return chunkFixed(
        trimmed,
        options.chunk_size ?? DEFAULT_CHUNK_SIZE,
        options.overlap_ratio ?? DEFAULT_OVERLAP_RATIO,
      );
    case ChunkStrategy.Sentence:
      return chunkSentences(trimmed);
    case ChunkStrategy.Paragraph:
      return chunkParagraphs(trimmed);
  }
}

/**
 * Split by whitespace-delimited "tokens" into windows of `size` tokens with
 * `overlapRatio` overlap between consecutive windows.
 *
 * This is a deliberate approximation — real BPE tokenization would require
 * pulling in a tokenizer dependency. For chunking purposes word counts track
 * BPE tokens closely enough (within ~25%).
 */
function chunkFixed(
  text: string,
  size: number,
  overlapRatio: number,
): string[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const clampedSize = Math.max(1, Math.floor(size));
  const clampedOverlap = Math.min(MAX_OVERLAP_RATIO, Math.max(0, overlapRatio));
  const overlapTokens = Math.floor(clampedSize * clampedOverlap);
  const step = Math.max(1, clampedSize - overlapTokens);

  const chunks: string[] = [];
  for (let i = 0; i < tokens.length; i += step) {
    const window = tokens.slice(i, i + clampedSize);
    if (window.length === 0) break;
    chunks.push(window.join(" "));
    if (i + clampedSize >= tokens.length) break;
  }
  return chunks;
}

/** Split on sentence-terminator punctuation followed by whitespace. */
function chunkSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Split on blank lines (one or more sequences of double-newline). */
function chunkParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}
