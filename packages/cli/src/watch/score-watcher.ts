import { dirname, resolve } from "node:path";
import { EventEmitter } from "node:events";
import chokidar, { type FSWatcher } from "chokidar";
import type { ScoreConfig } from "@tuttiai/types";
import { validateScore } from "@tuttiai/core";

/** How long to wait after the last change event before reloading. */
const DEFAULT_DEBOUNCE_MS = 200;

/** Default ignore-patterns for the directory-tree watch. */
const DEFAULT_IGNORED = [
  /(^|[/\\])\../, // dotfiles (.git, .env, etc.)
  /node_modules/,
  /[/\\]dist[/\\]/,
  /[/\\]coverage[/\\]/,
];

/**
 * Load a score module with ESM cache-busting. Node's ESM cache is per-URL
 * and cannot be invalidated, so we append a unique query parameter on
 * each reload to force a fresh module instance. The old instance stays in
 * memory — acceptable leak for a development-only watch loop.
 */
async function defaultLoadScore(path: string): Promise<ScoreConfig> {
  const absolute = resolve(path);
  // Node's ESM cache is per-URL and can't be invalidated — append a
  // unique query parameter so each reload gets a fresh module instance.
  // The previous instance stays in memory (small leak, acceptable for a
  // development-only watch loop).
  const { pathToFileURL } = await import("node:url");
  const url = pathToFileURL(absolute).href + "?t=" + Date.now().toString(36);
  const mod = (await import(url)) as { default?: ScoreConfig };
  if (!mod.default) {
    throw new Error(
      "Score file has no default export: " + path +
        " — your score must export `defineScore({ ... })` as its default.",
    );
  }
  // Validate the freshly-loaded score. `ScoreLoader.load` would have run
  // the same validator but on a stale cache entry, so we inline it.
  validateScore(mod.default);
  return mod.default;
}

export interface ReactiveScoreEvents {
  /** Emitted immediately when a watched file changes (before debounce settles). */
  "file-change": (changedPath: string) => void;
  /** Emitted when a reload attempt starts (after debounce). */
  reloading: () => void;
  /** Emitted when a reload succeeds — `current` now returns the new score. */
  reloaded: (score: ScoreConfig) => void;
  /**
   * Emitted when a reload fails. The previous `current` score is kept so
   * the REPL can continue with the last-known-good config.
   */
  "reload-failed": (error: Error) => void;
}

export interface ReactiveScoreOptions {
  /**
   * Additional paths or glob patterns to watch beyond the score file and
   * its parent directory. Useful when voices live elsewhere.
   */
  extraPaths?: string[];
  /** Debounce window in ms. Default 200. */
  debounceMs?: number;
  /**
   * Override the score loader. Primarily a test seam — production code
   * uses the default cache-busting ESM importer.
   */
  load?: (path: string) => Promise<ScoreConfig>;
}

/**
 * A {@link ScoreConfig} that refreshes itself when the underlying file
 * (or any file in its directory) changes on disk.
 *
 * Consumers read `reactive.current` before each turn and get the most
 * recent successfully-loaded score. On a reload failure (syntax error in
 * the score file, schema validation, etc.), `current` keeps returning the
 * previous value — callers can listen for `reload-failed` to surface the
 * error in their UI.
 */
export class ReactiveScore extends EventEmitter {
  private _current: ScoreConfig;
  private readonly scorePath: string;
  private readonly load: (path: string) => Promise<ScoreConfig>;
  private readonly debounceMs: number;
  private readonly watcher: FSWatcher;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private _pendingReload = false;

  constructor(
    initialScore: ScoreConfig,
    scorePath: string,
    options: ReactiveScoreOptions = {},
  ) {
    super();
    this._current = initialScore;
    this.scorePath = resolve(scorePath);
    this.load = options.load ?? defaultLoadScore;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

    // Watch the score file, its parent directory tree, and any extras.
    // Directory-tree watching catches voice files and local utility
    // modules without needing a proper import-graph resolver; the
    // trade-off is that unrelated files in the tree also trigger reloads.
    const watchTargets = [
      this.scorePath,
      dirname(this.scorePath),
      ...(options.extraPaths ?? []),
    ];
    this.watcher = chokidar.watch(watchTargets, {
      ignored: DEFAULT_IGNORED,
      ignoreInitial: true,
      // awaitWriteFinish: guard against partial writes from editors that
      // save atomically via rename/move.
      awaitWriteFinish: {
        stabilityThreshold: 50,
        pollInterval: 20,
      },
    });

    this.watcher.on("change", (path) => this.handleChange(path));
    this.watcher.on("add", (path) => this.handleChange(path));
  }

  /** The most recent successfully-loaded score. Never stale. */
  get current(): ScoreConfig {
    return this._current;
  }

  /**
   * True when a file change has been observed and a reload is pending
   * (or just completed and not yet consumed). Readers call
   * {@link consumePendingReload} to clear the flag when they've taken
   * action on the new config.
   */
  get pendingReload(): boolean {
    return this._pendingReload;
  }

  consumePendingReload(): void {
    this._pendingReload = false;
  }

  /** Release the underlying filesystem watchers. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    await this.watcher.close();
  }

  /**
   * Force an immediate reload without waiting for a filesystem event.
   * Exposed for tests and for the `reload` REPL command.
   */
  async reloadNow(): Promise<void> {
    if (this.closed) return;
    this.emit("reloading");
    try {
      const next = await this.load(this.scorePath);
      this._current = next;
      this._pendingReload = true;
      this.emit("reloaded", next);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("reload-failed", error);
    }
  }

  private handleChange(path: string): void {
    if (this.closed) return;
    this.emit("file-change", path);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      void this.reloadNow();
    }, this.debounceMs);
  }
}
