import { PDFParse } from "pdf-parse";

/**
 * Extract plain text from a PDF buffer using pdf-parse 2.x.
 *
 * The underlying parser owns a worker handle that must be released — we
 * always call `destroy()` in a `finally` block so errors don't leak.
 */
export async function parsePdf(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return result.text.trim();
  } finally {
    await parser.destroy();
  }
}
