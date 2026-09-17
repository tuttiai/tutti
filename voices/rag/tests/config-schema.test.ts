import { describe, it, expect } from "vitest";
import { RagVoiceConfigSchema } from "../src/index.js";

describe("RagVoiceConfigSchema", () => {
  it("accepts a minimal configuration", () => {
    expect(RagVoiceConfigSchema.parse({ collection: "docs" })).toEqual({ collection: "docs" });
  });

  it("requires collection", () => {
    expect(() => RagVoiceConfigSchema.parse({})).toThrow();
  });

  it("accepts each embedding provider variant", () => {
    const variants = [
      { provider: "openai" as const, api_key: "k" },
      { provider: "anthropic" as const, api_key: "k" },
      { provider: "local" as const, base_url: "http://127.0.0.1:11434", model: "nomic-embed-text" },
    ];
    for (const embeddings of variants) {
      expect(RagVoiceConfigSchema.parse({ collection: "docs", embeddings }).embeddings).toEqual(
        embeddings,
      );
    }
  });

  it("requires api_key on the openai variant", () => {
    expect(() =>
      RagVoiceConfigSchema.parse({ collection: "docs", embeddings: { provider: "openai" } }),
    ).toThrow();
  });

  it("requires model on the local variant, which the shared base fields make optional elsewhere", () => {
    expect(() =>
      RagVoiceConfigSchema.parse({
        collection: "docs",
        embeddings: { provider: "local", base_url: "http://127.0.0.1:11434" },
      }),
    ).toThrow();
  });

  it("leaves model optional on the openai variant", () => {
    const embeddings = { provider: "openai" as const, api_key: "k" };
    expect(RagVoiceConfigSchema.parse({ collection: "docs", embeddings }).embeddings).toEqual(
      embeddings,
    );
  });

  it("rejects an unknown embedding provider", () => {
    expect(() =>
      RagVoiceConfigSchema.parse({ collection: "docs", embeddings: { provider: "cohere" } }),
    ).toThrow();
  });

  it("accepts allow_private on the local variant, and it defaults to absent", () => {
    const embeddings = {
      provider: "local" as const,
      base_url: "http://127.0.0.1:11434",
      model: "nomic-embed-text",
    };
    expect(RagVoiceConfigSchema.parse({ collection: "docs", embeddings }).embeddings).not.toHaveProperty(
      "allow_private",
    );
    const opened = { ...embeddings, allow_private: true };
    expect(RagVoiceConfigSchema.parse({ collection: "docs", embeddings: opened }).embeddings).toEqual(
      opened,
    );
  });

  it("accepts both vector store variants and rejects a third", () => {
    expect(RagVoiceConfigSchema.parse({ collection: "d", storage: { provider: "memory" } })).toBeTruthy();
    expect(
      RagVoiceConfigSchema.parse({ collection: "d", storage: { provider: "pgvector", table: "t" } }),
    ).toBeTruthy();
    expect(() =>
      RagVoiceConfigSchema.parse({ collection: "d", storage: { provider: "qdrant" } }),
    ).toThrow();
  });

  it("rejects a negative chunk overlap", () => {
    expect(() => RagVoiceConfigSchema.parse({ collection: "d", chunk_overlap: -1 })).toThrow();
  });
});
