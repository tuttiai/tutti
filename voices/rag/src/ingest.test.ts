import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chunkText } from "./chunking.js";
import { ingestDocument } from "./ingest.js";
import { ChunkStrategy } from "./types.js";
import { toRawUrl, isGitHubUrl } from "./sources/github.js";
import { assertSafeUrl, UrlValidationError } from "./utils/url-guard.js";

// ---------------------------------------------------------------------------
// pdf-parse is mocked globally — avoids bundling a fixture PDF and keeps the
// suite fast. Tests that want to inspect the raw parser can override.
// ---------------------------------------------------------------------------
vi.mock("pdf-parse", () => {
  class PDFParse {
    constructor(public options: unknown) {}
    getText(): Promise<{ text: string }> {
      return Promise.resolve({
        text: "Hello from PDF.\n\nSecond paragraph.",
      });
    }
    destroy(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { PDFParse };
});

// ===========================================================================
// chunkText — strategy coverage
// ===========================================================================

describe("chunkText", () => {
  describe("fixed strategy", () => {
    it("returns one chunk when input fits in the window", () => {
      const chunks = chunkText("one two three", {
        strategy: ChunkStrategy.Fixed,
        chunk_size: 10,
      });
      expect(chunks).toEqual(["one two three"]);
    });

    it("splits into overlapping windows at the requested size", () => {
      const text = Array.from({ length: 20 }, (_, i) => "w" + i).join(" ");
      const chunks = chunkText(text, {
        strategy: ChunkStrategy.Fixed,
        chunk_size: 10,
        overlap_ratio: 0.2, // overlap = 2 tokens, step = 8
      });
      expect(chunks).toHaveLength(3);
      expect(chunks[0].split(" ")).toHaveLength(10);
      // last two tokens of chunk 0 must match first two of chunk 1 (20% overlap).
      const tail0 = chunks[0].split(" ").slice(-2);
      const head1 = chunks[1].split(" ").slice(0, 2);
      expect(head1).toEqual(tail0);
    });

    it("defaults to 512 tokens and 20% overlap", () => {
      const text = Array.from({ length: 600 }, (_, i) => "w" + i).join(" ");
      const chunks = chunkText(text); // all defaults
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks[0].split(" ")).toHaveLength(512);
    });

    it("returns [] for empty input", () => {
      expect(chunkText("")).toEqual([]);
      expect(chunkText("   \n\n  ")).toEqual([]);
    });

    it("clamps absurd overlap ratios", () => {
      const text = Array.from({ length: 30 }, (_, i) => "w" + i).join(" ");
      const chunks = chunkText(text, {
        strategy: ChunkStrategy.Fixed,
        chunk_size: 10,
        overlap_ratio: 5, // clamped to 0.9 → step = 1
      });
      // With step=1 and size=10 over 30 tokens → 21 chunks.
      expect(chunks).toHaveLength(21);
    });
  });

  describe("sentence strategy", () => {
    it("splits on ., !, and ?", () => {
      const chunks = chunkText("First. Second! Third? Fourth.", {
        strategy: ChunkStrategy.Sentence,
      });
      expect(chunks).toEqual(["First.", "Second!", "Third?", "Fourth."]);
    });

    it("keeps a single sentence as one chunk", () => {
      const chunks = chunkText("Just one sentence with no punctuation", {
        strategy: ChunkStrategy.Sentence,
      });
      expect(chunks).toEqual(["Just one sentence with no punctuation"]);
    });

    it("ignores empty fragments", () => {
      const chunks = chunkText("A.  B.   C.", {
        strategy: ChunkStrategy.Sentence,
      });
      expect(chunks).toEqual(["A.", "B.", "C."]);
    });
  });

  describe("paragraph strategy", () => {
    it("splits on blank lines", () => {
      const chunks = chunkText("First para.\n\nSecond para.\n\nThird.", {
        strategy: ChunkStrategy.Paragraph,
      });
      expect(chunks).toEqual(["First para.", "Second para.", "Third."]);
    });

    it("treats multiple blank lines as one separator", () => {
      const chunks = chunkText("A\n\n\n\nB\n\n   \n\nC", {
        strategy: ChunkStrategy.Paragraph,
      });
      expect(chunks).toEqual(["A", "B", "C"]);
    });

    it("returns a single chunk when there are no blank lines", () => {
      const chunks = chunkText("single\nline\nbreaks", {
        strategy: ChunkStrategy.Paragraph,
      });
      expect(chunks).toEqual(["single\nline\nbreaks"]);
    });
  });
});

// ===========================================================================
// ingestDocument — input-type coverage
// ===========================================================================

describe("ingestDocument", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "rag-ingest-"));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("ingests a plain-text file", async () => {
    const filePath = join(workDir, "notes.txt");
    await writeFile(filePath, "Hello world. This is a test.");

    const chunks = await ingestDocument(
      { source_id: "notes", path: filePath, title: "Notes" },
      { strategy: ChunkStrategy.Sentence },
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      text: "Hello world.",
      source_id: "notes",
      chunk_index: 0,
    });
    expect(chunks[0].metadata).toMatchObject({
      format: "text",
      strategy: "sentence",
      title: "Notes",
    });
    expect(chunks[1].chunk_index).toBe(1);
  });

  it("ingests a markdown file, stripping frontmatter and formatting", async () => {
    const filePath = join(workDir, "readme.md");
    const body = [
      "---",
      "title: Demo",
      "tags: [a, b]",
      "---",
      "",
      "# Heading",
      "",
      "Some **bold** text with a [link](https://example.com).",
      "",
      "Another paragraph.",
    ].join("\n");
    await writeFile(filePath, body);

    const chunks = await ingestDocument(
      { source_id: "readme", path: filePath },
      { strategy: ChunkStrategy.Paragraph },
    );

    const joined = chunks.map((c) => c.text).join("\n");
    expect(joined).not.toContain("---");
    expect(joined).not.toContain("title: Demo");
    expect(joined).not.toContain("**");
    expect(joined).not.toContain("](");
    expect(joined).toContain("Heading");
    expect(joined).toContain("bold");
    expect(joined).toContain("Another paragraph");
    expect(chunks[0].metadata).toMatchObject({ format: "markdown" });
  });

  it("ingests a PDF file via pdf-parse", async () => {
    const filePath = join(workDir, "doc.pdf");
    // Contents don't matter — pdf-parse is mocked at the top of this file.
    await writeFile(filePath, Buffer.from("%PDF-1.4 fake bytes"));

    const chunks = await ingestDocument(
      { source_id: "pdf-1", path: filePath },
      { strategy: ChunkStrategy.Paragraph },
    );

    expect(chunks.map((c) => c.text)).toEqual([
      "Hello from PDF.",
      "Second paragraph.",
    ]);
    expect(chunks[0].metadata).toMatchObject({ format: "pdf" });
  });

  it("ingests a remote URL and uses the HTTP content-type", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response("First. Second. Third.", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const chunks = await ingestDocument(
      { source_id: "web-1", url: "https://example.com/doc" },
      { strategy: ChunkStrategy.Sentence },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(chunks.map((c) => c.text)).toEqual(["First.", "Second.", "Third."]);
    expect(chunks[0].metadata).toMatchObject({ format: "text" });
  });

  it("ingests a GitHub blob URL by rewriting to raw.githubusercontent.com", async () => {
    const fetchMock: typeof fetch = vi.fn(() =>
      Promise.resolve(
        new Response("one two three four five", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const chunks = await ingestDocument(
      {
        source_id: "gh-1",
        url: "https://github.com/acme/widgets/blob/main/README.md",
      },
      { strategy: ChunkStrategy.Fixed, chunk_size: 100 },
    );

    const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    const first = calls[0]?.[0];
    const calledHref =
      first instanceof URL ? first.href : String(first);
    expect(calledHref).toBe(
      "https://raw.githubusercontent.com/acme/widgets/main/README.md",
    );
    // README.md should be parsed as markdown due to the .md extension.
    expect(chunks[0].metadata).toMatchObject({ format: "markdown" });
  });

  it("rejects inputs with both path and url", async () => {
    await expect(
      ingestDocument({ source_id: "x", path: "/a", url: "https://a" }),
    ).rejects.toThrow(/exactly one/);
  });

  it("rejects inputs with neither path nor url", async () => {
    await expect(
      ingestDocument({ source_id: "x" }),
    ).rejects.toThrow(/required/);
  });
});

// ===========================================================================
// URL / GitHub helpers
// ===========================================================================

describe("assertSafeUrl", () => {
  it("accepts http(s) URLs", () => {
    expect(() => assertSafeUrl("https://example.com")).not.toThrow();
    expect(() => assertSafeUrl("http://example.com")).not.toThrow();
  });

  it.each([
    "file:///etc/passwd",
    "ftp://example.com",
    "http://localhost:3000",
    "http://127.0.0.1",
    "http://10.0.0.5",
    "http://192.168.1.1",
    "http://172.16.0.1",
    "http://169.254.169.254", // AWS metadata
    "not a url",
  ])("rejects %s", (url) => {
    expect(() => assertSafeUrl(url)).toThrow(UrlValidationError);
  });
});

describe("GitHub URL handling", () => {
  it("recognises github.com and raw.githubusercontent.com", () => {
    expect(isGitHubUrl("https://github.com/a/b/blob/main/x.md")).toBe(true);
    expect(
      isGitHubUrl("https://raw.githubusercontent.com/a/b/main/x.md"),
    ).toBe(true);
    expect(isGitHubUrl("https://example.com")).toBe(false);
    expect(isGitHubUrl("not-a-url")).toBe(false);
  });

  it("rewrites blob URLs to raw URLs", () => {
    expect(
      toRawUrl("https://github.com/acme/w/blob/feature-x/docs/file.md"),
    ).toBe(
      "https://raw.githubusercontent.com/acme/w/feature-x/docs/file.md",
    );
  });

  it("passes through already-raw URLs", () => {
    const raw = "https://raw.githubusercontent.com/a/b/main/x.md";
    expect(toRawUrl(raw)).toBe(raw);
  });

  it("throws on bare repo URLs (not yet supported)", () => {
    expect(() => toRawUrl("https://github.com/acme/widgets")).toThrow(
      /not supported/,
    );
  });
});
