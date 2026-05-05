import { createReadStream, statSync } from "node:fs";
import { extname, isAbsolute, normalize, relative, resolve } from "node:path";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
};

function contentType(file: string): string {
  return MIME_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Resolve a request path to an absolute file inside `root`. Returns
 * `undefined` for any request that escapes the root or doesn't point at
 * a regular file.
 *
 * Two layered barriers — both are also the sanitiser shapes CodeQL's
 * `js/path-injection` query recognises:
 *  1. Reject inputs whose components contain `..` or NUL bytes before we
 *     touch the filesystem.
 *  2. After `resolve()`, recompute the path relative to `root` and reject
 *     anything that goes upwards (`..`) or escapes to an absolute path.
 */
function resolveSafe(root: string, requestPath: string): string | undefined {
  const trimmed = requestPath.replace(/^\/+/, "");

  const segments = trimmed.split(/[\\/]/);
  if (segments.includes("..") || trimmed.includes("\0")) {
    return undefined;
  }

  const candidate = resolve(root, normalize(trimmed));

  const rel = relative(root, candidate);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return undefined;
  }

  try {
    // Path is verified to be inside `root` immediately above — safe to stat.
    const stat = statSync(candidate);
    if (!stat.isFile()) return undefined;
  } catch {
    return undefined;
  }
  return candidate;
}

async function sendFile(reply: FastifyReply, file: string): Promise<FastifyReply> {
  // `file` always comes from `resolveSafe` (or the trusted `indexFile`).
  return reply
    .type(contentType(file))
    .header("cache-control", "no-cache")
    .send(createReadStream(file));
}

/**
 * Register `GET /studio` and `GET /studio/*` — serve the built
 * `@tuttiai/studio` SPA from a directory on disk.
 *
 * Behaviour:
 *  - `/studio` and `/studio/` redirect to `index.html`.
 *  - Asset paths under `/studio/` map 1:1 onto files in `distDir`.
 *  - Anything that doesn't match a real file falls back to `index.html`,
 *    so client-side routes inside the SPA work on full-page reload.
 *
 * @param app     - Fastify instance.
 * @param distDir - Absolute path to the studio's built `dist/` directory.
 */
export function registerStudioRoute(app: FastifyInstance, distDir: string): void {
  const root = resolve(distDir);

  // Fail fast at server start if the SPA bundle is missing — every studio
  // request would otherwise 500 once it falls through to `sendFile(indexFile)`.
  // `resolveSafe` doubles as the existence + sanitiser check.
  const indexFile = resolveSafe(root, "index.html");
  if (!indexFile) {
    throw new Error(
      `Studio dist directory is missing index.html: ${resolve(root, "index.html")}. ` +
        `Build @tuttiai/studio (npm -w @tuttiai/studio run build) or unset studio_dist_dir.`,
    );
  }

  const handler = async (
    request: FastifyRequest<{ Params: { "*"?: string } }>,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    const sub = request.params["*"] ?? "";
    if (sub === "" || sub === "/") {
      return sendFile(reply, indexFile);
    }
    const file = resolveSafe(root, sub);
    if (file) return sendFile(reply, file);
    // SPA fallback — let the React app handle unknown paths client-side.
    return sendFile(reply, indexFile);
  };

  app.get<{ Params: { "*"?: string } }>("/studio", handler);
  app.get<{ Params: { "*"?: string } }>("/studio/*", handler);
}
