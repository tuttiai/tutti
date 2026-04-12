import { resolve } from "node:path";

export class PathTraversalError extends Error {
  public readonly code = "PATH_TRAVERSAL";
  constructor(public readonly path: string, message?: string) {
    super(message ?? `Path traversal detected: "${path}" is not allowed.`);
    this.name = "PathTraversalError";
  }
}

export class PathSanitizer {
  static sanitize(inputPath: string, baseDir?: string): string {
    const resolved = resolve(inputPath);
    if (baseDir) {
      const resolvedBase = resolve(baseDir);
      if (!resolved.startsWith(resolvedBase)) {
        throw new PathTraversalError(inputPath, "Path traversal detected: must stay within " + resolvedBase);
      }
    }
    return resolved;
  }

  static assertSafe(filePath: string): void {
    const dangerous = [
      "/etc/passwd",
      "/etc/shadow",
      "/etc/hosts",
      "~/.ssh",
      "~/.aws",
      "/proc",
      "/sys",
      "/dev",
    ];
    const resolved = resolve(filePath);
    for (const d of dangerous) {
      if (resolved.startsWith(resolve(d))) {
        throw new PathTraversalError(filePath, "Access to system path not allowed: " + d);
      }
    }
  }

  static async assertMaxSize(
    filePath: string,
    maxBytes = 10_000_000,
  ): Promise<void> {
    const { stat } = await import("node:fs/promises");
    const stats = await stat(filePath);
    if (stats.size > maxBytes) {
      throw new Error(
        "File too large: " + stats.size + " bytes (max: " + maxBytes + ")",
      );
    }
  }
}
