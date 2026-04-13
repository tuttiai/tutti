import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { RagContext } from "../tool-context.js";

const parameters = z.object({});

type ListSourcesInput = z.infer<typeof parameters>;

interface FormattedSource {
  source_id: string;
  filename: string;
  chunks: number;
  ingested_at: string;
}

/** Wire the `list_sources` tool — enumerate every source in the store. */
export function createListSourcesTool(
  ctx: RagContext,
): Tool<ListSourcesInput> {
  return {
    name: "list_sources",
    description: "List every ingested source document",
    parameters,
    execute: async (): Promise<{ content: string; is_error?: boolean }> => {
      try {
        const sources = await ctx.store.list();
        const formatted: FormattedSource[] = sources.map((s) => {
          const meta = s.metadata ?? {};
          const metaFilename =
            typeof meta.filename === "string" ? meta.filename : undefined;
          return {
            source_id: s.source_id,
            filename: metaFilename ?? s.title ?? s.source_id,
            chunks: s.chunk_count,
            ingested_at: s.ingested_at,
          };
        });
        return { content: JSON.stringify(formatted) };
      } catch (err) {
        return {
          content:
            "list_sources failed: " +
            (err instanceof Error ? err.message : String(err)),
          is_error: true,
        };
      }
    },
  };
}
