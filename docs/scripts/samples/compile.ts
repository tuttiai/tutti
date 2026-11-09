import { join } from "node:path";
import type * as TS from "typescript";
import type { Sample, SampleDiagnostic, SampleResult } from "./types.js";

/** The TypeScript module. Injected, so the entry can pin the root copy and tests pass their own. */
export type TypeScript = typeof TS;

/** Every sample's diagnostics, plus any that belong to no sample. */
export interface CompileOutcome {
  readonly results: readonly SampleResult[];
  /** Options and global diagnostics, such as missing `@types/node`: the check is incomplete. */
  readonly global: readonly string[];
}

/**
 * The options every sample is checked with. They match tsconfig.base.json where that matters to
 * a reader (strict, ES2022, bundler resolution) and leave out the hygiene flags samples break on
 * purpose (`noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`). Each block is forced
 * to be its own module, so top-level names never clash and top-level `await` works.
 *
 * @param ts - The TypeScript module.
 * @returns The compiler options.
 */
export function compilerOptions(ts: TypeScript): TS.CompilerOptions {
  return {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    types: ["node"],
    noEmit: true,
    skipLibCheck: true,
    isolatedModules: true,
    resolveJsonModule: true,
    esModuleInterop: true,
    jsx: ts.JsxEmit.Preserve,
    moduleDetection: ts.ModuleDetectionKind.Force,
  };
}

/**
 * Where a sample lives in the program: under `<root>/.docs-samples/`, a path nothing writes to.
 * It sits at the root, so imports resolve through the root node_modules, where npm links the
 * workspace packages, and never through docs/node_modules.
 *
 * @param root - Absolute path of the repository root.
 * @param sample - The sample.
 * @returns The sample's virtual file path.
 */
export function virtualPath(root: string, sample: Sample): string {
  return join(root, ".docs-samples", sample.file, `${sample.heading || "_"}-${sample.index}.${sample.lang}`);
}

function createHost(ts: TypeScript, root: string, files: ReadonlyMap<string, Sample>): TS.CompilerHost {
  const host = ts.createCompilerHost(compilerOptions(ts), true);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  return {
    ...host,
    getCurrentDirectory: () => root,
    fileExists: (name) => files.has(name) || fileExists(name),
    readFile: (name) => files.get(name)?.code ?? readFile(name),
    getSourceFile: (name, language, onError, create) => {
      const sample = files.get(name);
      if (sample === undefined) return getSourceFile(name, language, onError, create);
      const kind = sample.lang === "tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      return ts.createSourceFile(name, sample.code, language, true, kind);
    },
  };
}

/** Places a diagnostic in the .mdx file: the block's first content line, plus the fence indent. */
function place(ts: TypeScript, sample: Sample, diagnostic: TS.Diagnostic): SampleDiagnostic {
  const at =
    diagnostic.file !== undefined && diagnostic.start !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      : { line: 0, character: 0 };
  return {
    line: sample.startLine + at.line,
    column: sample.indent + at.character + 1,
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
  };
}

/**
 * Type-checks every sample in one program, in memory: nothing is written to disk. Libraries and
 * workspace packages are read from disk as usual, so `@tuttiai/*` imports resolve to the built
 * declarations users install, which means the workspaces must be built first.
 *
 * @param ts - The TypeScript module.
 * @param root - Absolute path of the repository root.
 * @param samples - The samples to check.
 * @returns Each sample's diagnostics, mapped to its .mdx file, and any global ones.
 */
export function compileSamples(ts: TypeScript, root: string, samples: readonly Sample[]): CompileOutcome {
  const files = new Map(samples.map((sample) => [virtualPath(root, sample), sample]));
  const program = ts.createProgram([...files.keys()], compilerOptions(ts), createHost(ts, root, files));
  const global = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()].map(
    (d) => `TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
  );
  const results = [...files].map(([path, sample]) => {
    const source = program.getSourceFile(path);
    const found = source === undefined ? [] : [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
    return { sample, diagnostics: found.map((d) => place(ts, sample, d)) };
  });
  return { results, global };
}
