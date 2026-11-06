import type { DirEntry, IntegrityFs } from "../../scripts/integrity/discover.js";
import type { Writer } from "../../scripts/integrity/run.js";

/** The repository root every fake path hangs off. */
export const ROOT = "/repo";

/** A fake repository: file contents by relative path, plus paths that are symlinks or unreadable. */
export interface FakeTree {
  readonly files: Readonly<Record<string, string>>;
  readonly symlinks?: readonly string[];
  readonly unreadable?: readonly string[];
}

type Kind = "file" | "dir" | "link";

function relativeTo(path: string): string {
  return path === ROOT ? "" : path.slice(ROOT.length + 1);
}

/** An Error carrying a Node-style `code`, as `node:fs` rejects with. */
export function errno(code: string): Error {
  return Object.assign(new Error(`${code}: fake`), { code });
}

function childrenOf(tree: FakeTree, dir: string): Map<string, Kind> {
  const prefix = dir === "" ? "" : `${dir}/`;
  const links = new Set(tree.symlinks ?? []);
  const children = new Map<string, Kind>();
  for (const path of [...Object.keys(tree.files), ...links]) {
    if (!path.startsWith(prefix)) continue;
    const [head = "", ...rest] = path.slice(prefix.length).split("/");
    const kind: Kind = links.has(path) ? "link" : "file";
    children.set(head, rest.length > 0 ? "dir" : kind);
  }
  return children;
}

function entry(name: string, kind: Kind): DirEntry {
  return {
    name,
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => kind === "link",
  };
}

/** An IntegrityFs over a FakeTree, so tests touch no disk. A missing directory is ENOENT. */
export function fakeFs(tree: FakeTree): IntegrityFs {
  const contents = new Map(Object.entries(tree.files));
  return {
    readdir: (dir) => {
      const children = childrenOf(tree, relativeTo(dir));
      if (children.size === 0 && dir !== ROOT) return Promise.reject(errno("ENOENT"));
      return Promise.resolve([...children].map(([name, kind]) => entry(name, kind)));
    },
    readFile: (path) => {
      const rel = relativeTo(path);
      const text = contents.get(rel);
      if (text === undefined || (tree.unreadable ?? []).includes(rel)) return Promise.reject(errno("EACCES"));
      return Promise.resolve(text);
    },
  };
}

/** A Writer that keeps every line, split by stream. */
export function captureWriter(): { write: Writer; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { write: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}
