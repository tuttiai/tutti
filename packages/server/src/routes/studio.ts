import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

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
 * Resolve a request path to an absolute file inside `root`. Rejects any
 * resolved path that escapes the root (defence in depth against path
 * traversal). Returns `undefined` when the candidate is not a regular file.
 */
function resolveSafe(root: string, requestPath: string): string | undefined {
  const trimmed = requestPath.replace(/^\/+/, "");
  const candidate = resolve(root, normalize(trimmed));

  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) {
    return undefined;
  }

  try {
    // Path is verified to be inside `root` immediately above — safe to stat.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const stat = statSync(candidate);
    if (!stat.isFile()) return undefined;
  } catch {
    return undefined;
  }
  return candidate;
}

async function sendFile(reply: FastifyReply, file: string): Promise<FastifyReply> {
  return reply
    .type(contentType(file))
    .header("cache-control", "no-cache")
    // `file` always comes from `resolveSafe` (or the trusted `indexFile`).
    // eslint-disable-next-line security/detect-non-literal-fs-filename
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
  const indexFile = join(root, "index.html");

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
