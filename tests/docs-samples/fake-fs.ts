import { resolve } from "node:path";
import type { DirEntry, SamplesFs } from "../../docs/scripts/samples/discover.js";
import type { Writer } from "../../docs/scripts/samples/report.js";

/**
 * The real repository root. The compile step reads TypeScript's libs and @types/node from disk
 * under it, while every docs and package file a test needs comes from the fake tree.
 */
export const ROOT = resolve(import.meta.dirname, "../..");

/** File contents by path relative to {@link ROOT}. */
export type FakeTree = Readonly<Record<string, string>>;

function entry(name: string, dir: boolean): DirEntry {
  return { name, isFile: () => !dir, isDirectory: () => dir };
}

function relativeTo(root: string, path: string): string {
  return path === root ? "" : path.slice(root.length + 1);
}

function childrenOf(tree: FakeTree, dir: string): DirEntry[] {
  const children = new Map<string, boolean>();
  for (const path of Object.keys(tree)) {
    if (!path.startsWith(`${dir}/`)) continue;
    const [head = "", ...rest] = path.slice(dir.length + 1).split("/");
    children.set(head, rest.length > 0);
  }
  return [...children].map(([name, isDir]) => entry(name, isDir));
}

/** A SamplesFs over a FakeTree under `root`, so tests touch no docs or package file on disk. */
export function fakeFs(tree: FakeTree, root: string = ROOT): SamplesFs {
  const relative = (path: string): string => relativeTo(root, path);
  const isDir = (rel: string): boolean => Object.keys(tree).some((path) => path.startsWith(`${rel}/`));
  return {
    readdir: (dir) => Promise.resolve(childrenOf(tree, relative(dir))),
    readFile: (path) => {
      const text = tree[relative(path)];
      if (text === undefined) return Promise.reject(Object.assign(new Error("ENOENT: fake"), { code: "ENOENT" }));
      return Promise.resolve(text);
    },
    exists: (path) => Promise.resolve(tree[relative(path)] !== undefined || isDir(relative(path))),
  };
}

/** A Writer that keeps every line, split by stream. */
export function captureWriter(): { write: Writer; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { write: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}
