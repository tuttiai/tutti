import { basename } from "node:path";
import { assertSafeUrl } from "../utils/url-guard.js";
import type { LoadedSource } from "./file.js";

const MAX_BYTES = 25_000_000; // 25 MB

/**
 * Fetch a document over HTTP(S). Rejects private/loopback hosts and
 * non-http(s) schemes via {@link assertSafeUrl}.
 */
export async function loadFromUrl(url: string): Promise<LoadedSource> {
  const parsed = assertSafeUrl(url);

  const response = await fetch(parsed, {
    redirect: "follow",
    headers: { "User-Agent": "tuttiai-rag/0.1" },
  });
  if (!response.ok) {
    throw new Error("HTTP " + response.status + " fetching " + parsed.href);
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BYTES) {
    throw new Error(
      "Remote document too large: " + contentLength + " bytes (max " + MAX_BYTES + ")",
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_BYTES) {
    throw new Error("Remote document exceeded size cap after download");
  }

  const mime = response.headers.get("content-type")?.split(";")[0]?.trim();
  const filename = basename(parsed.pathname) || parsed.hostname;

  return {
    buffer: Buffer.from(arrayBuffer),
    filename,
    mime_type: mime,
  };
}
