import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import { ingestDocument } from "../ingest.js";
import type { EmbeddedChunk } from "../stores/types.js";
import { ChunkStrategy, type ChunkOptions, type IngestSourceInput } from "../types.js";
import {
  deriveSourceId,
  filenameFor,
  isUrl,
  type RagContext,
} from "../tool-context.js";

const parameters = z.object({
  source: z
    .string()
    .min(1)
    .describe("Local file path, HTTP(S) URL, or GitHub blob URL"),
  source_id: z
    .string()
    .optional()
    .describe("Stable identifier. Defaults to a hash-derived value."),
  title: z.string().optional().describe("Human-readable title"),
  mime_type: z
    .string()
    .optional()
    .describe("MIME type override (auto-detected when omitted)"),
  strategy: z
    .nativeEnum(ChunkStrategy)
    .optional()
    .describe("Chunking strategy: fixed (default), sentence, or paragraph"),
  chunk_size: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Target tokens per chunk for the fixed strategy"),
  overlap_ratio: z
    .number()
    .min(0)
    .max(0.9)
    .optional()
    .describe("Overlap fraction between windows for the fixed strategy"),
  metadata: z
    .record(z.unknown())
    .optional()
    .describe("Free-form metadata propagated to every chunk"),
});

type IngestDocumentInput = z.infer<typeof parameters>;

/**
 * Wire the `ingest_document` tool: load + parse + chunk + embed + persist.
 * Returns `{ source_id, chunks_created, source }` on success.
 */
export function createIngestDocumentTool(
  ctx: RagContext,
): Tool<IngestDocumentInput> {
  return {
    name: "ingest_document",
    description:
      "Ingest a document (path, URL, or GitHub blob URL) into the knowledge base",
    parameters,
    execute: async (input): Promise<{ content: string; is_error?: boolean }> => {
      try {
        const id = input.source_id ?? deriveSourceId(input.source);
        const filename = filenameFor(input.source);

        const pipelineInput: IngestSourceInput = {
          source_id: id,
          ...(isUrl(input.source)
            ? { url: input.source }
            : { path: input.source }),
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.mime_type !== undefined
            ? { mime_type: input.mime_type }
            : {}),
          metadata: {
            ...(input.metadata ?? {}),
            source_id: id,
            source: input.source,
            filename,
          },
        };

        const chunkOptions: ChunkOptions = {
          ...(input.strategy !== undefined ? { strategy: input.strategy } : {}),
          ...(input.chunk_size !== undefined
            ? { chunk_size: input.chunk_size }
            : {}),
          ...(input.overlap_ratio !== undefined
            ? { overlap_ratio: input.overlap_ratio }
            : {}),
        };

        const chunks = await ingestDocument(pipelineInput, chunkOptions);
        if (chunks.length === 0) {
          return {
            content:
              "ingest_document produced no chunks from " + input.source +
              " — check that the document is non-empty and a supported format",
            is_error: true,
          };
        }

        const vectors = await ctx.embeddings.embed(chunks.map((c) => c.text));
        if (vectors.length !== chunks.length) {
          return {
            content:
              "ingest_document: embedding provider returned " +
              vectors.length +
              " vectors for " +
              chunks.length +
              " chunks",
            is_error: true,
          };
        }

        const embedded: EmbeddedChunk[] = [];
        for (const [i, c] of chunks.entries()) {
          // Bounded numeric index — length guard above ensures this is in range.
          // eslint-disable-next-line security/detect-object-injection
          const vector = vectors[i];
          embedded.push({
            ...c,
            vector,
            chunk_id: id + ":" + c.chunk_index,
            metadata: {
              ...(c.metadata ?? {}),
              chunk_index: c.chunk_index,
            },
          });
        }

        await ctx.store.upsert(embedded);
        ctx.engine.index(embedded);

        return {
          content: JSON.stringify({
            source_id: id,
            chunks_created: embedded.length,
            source: input.source,
          }),
        };
      } catch (err) {
        return {
          content:
            "ingest_document failed: " +
            (err instanceof Error ? err.message : String(err)),
          is_error: true,
        };
      }
    },
  };
}
