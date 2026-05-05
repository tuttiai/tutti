import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import chalk from "chalk";
import {
  TuttiRuntime,
  ScoreLoader,
  AnthropicProvider,
  OpenAIProvider,
  GeminiProvider,
  SecretsManager,
  InMemorySessionStore,
} from "@tuttiai/core";
import type { GraphConfig, TuttiGraph } from "@tuttiai/core";
import type { ScoreConfig, SessionStore } from "@tuttiai/types";
import { createServer, DEFAULT_PORT, SERVER_VERSION } from "@tuttiai/server";
import type { FastifyInstance } from "fastify";
import { ReactiveScore } from "../watch/score-watcher.js";
import { logger } from "../logger.js";

export interface ServeOptions {
  port?: string;
  host?: string;
  apiKey?: string;
  agent?: string;
  watch?: boolean;
  studio?: boolean;
  realtime?: boolean;
}

/**
 * Pull a {@link GraphConfig} off a loaded score, if one was attached as
 * `score.graph`.
 *
 * The score schema uses `.passthrough()` so unknown fields like `graph`
 * survive validation. This duck-types two shapes — a raw `GraphConfig`
 * object (with `nodes`/`edges` arrays) and a constructed `TuttiGraph`
 * instance (which exposes its config under `.config`). Returns
 * `undefined` when neither shape matches, so the studio canvas falls
 * back to its empty state.
 */
function extractGraphConfig(score: ScoreConfig): GraphConfig | undefined {
  const candidate = (score as unknown as { graph?: unknown }).graph;
  if (candidate === undefined || candidate === null) return undefined;
  if (typeof candidate !== "object") return undefined;

  const obj = candidate as Record<string, unknown>;
  // TuttiGraph instances expose the validated config on `.config`.
  if (obj["config"] && typeof obj["config"] === "object") {
    const inner = obj["config"] as Record<string, unknown>;
    if (Array.isArray(inner["nodes"]) && Array.isArray(inner["edges"])) {
      return obj["config"] as GraphConfig;
    }
  }
  // Or callers may attach a raw GraphConfig directly.
  if (Array.isArray(obj["nodes"]) && Array.isArray(obj["edges"])) {
    return candidate as GraphConfig;
  }
  return undefined;
}

/**
 * Resolve the absolute path to the built `@tuttiai/studio` SPA. Returns
 * `undefined` when the package is not installed or has not been built —
 * the caller is expected to surface a friendly error in that case.
 */
function resolveStudioDistDir(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@tuttiai/studio/package.json");
    const distDir = resolve(dirname(pkgPath), "dist");
    if (!existsSync(resolve(distDir, "index.html"))) return undefined;
    return distDir;
  } catch {
    return undefined;
  }
}

export async function serveCommand(
  scorePath?: string,
  options: ServeOptions = {},
): Promise<void> {
  // ── Resolve score file ──────────────────────────────────────
  const file = resolve(scorePath ?? "./tutti.score.ts");

  if (!existsSync(file)) {
    logger.error({ file }, "Score file not found");
    console.error(chalk.dim('Run "tutti-ai init" to create a new project.'));
    process.exit(1);
  }

  let score: ScoreConfig;
  try {
    score = await ScoreLoader.load(file);
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "Failed to load score",
    );
    process.exit(1);
  }

  // ── Validate provider API key ───────────────────────────────
  const providerKeyMap: [unknown, string][] = [
    [AnthropicProvider, "ANTHROPIC_API_KEY"],
    [OpenAIProvider, "OPENAI_API_KEY"],
    [GeminiProvider, "GEMINI_API_KEY"],
  ];

  for (const [ProviderClass, envVar] of providerKeyMap) {
    if (score.provider instanceof (ProviderClass as new (...args: unknown[]) => unknown)) {
      const key = SecretsManager.optional(envVar);
      if (!key) {
        logger.error({ envVar }, "Missing API key");
        process.exit(1);
      }
    }
  }

  // ── Resolve agent name ──────────────────────────────────────
  const agentNames = Object.keys(score.agents);
  const agentName =
    options.agent ??
    (typeof score.entry === "string" ? score.entry : undefined) ??
    agentNames[0];

  if (!agentName || !Object.hasOwn(score.agents, agentName)) {
    logger.error(
      { requested: agentName, available: agentNames },
      "Agent not found in score",
    );
    process.exit(1);
  }

  // ── Resolve port & host ─────────────────────────────────────
  const port = parsePort(options.port);
  const host = options.host ?? "0.0.0.0";

  // ── Resolve studio dist (if --studio) ───────────────────────
  let studioDistDir: string | undefined;
  if (options.studio) {
    studioDistDir = resolveStudioDistDir();
    if (!studioDistDir) {
      logger.error(
        "Cannot enable --studio: @tuttiai/studio is not installed or has not been built. Run `npm install @tuttiai/studio` and `npm run build -w @tuttiai/studio`.",
      );
      process.exit(1);
    }
  }

  // ── Build runtime and server ────────────────────────────────
  // Watch mode keeps a shared session store so hot-reloads don't
  // discard in-flight sessions.
  const sharedSessions: SessionStore | undefined = options.watch
    ? new InMemorySessionStore()
    : undefined;

  let runtime = buildRuntime(score, sharedSessions);
  const initialGraphConfig = extractGraphConfig(score);
  const initialGraphRunner: TuttiGraph | undefined = initialGraphConfig
    ? runtime.createGraph(initialGraphConfig)
    : undefined;
  let app = await buildApp(
    runtime,
    agentName,
    port,
    host,
    options.apiKey,
    studioDistDir,
    initialGraphConfig,
    initialGraphRunner,
    options.realtime === true ? score : undefined,
  );

  // ── Watch mode ──────────────────────────────────────────────
  let reactive: ReactiveScore | undefined;
  if (options.watch) {
    reactive = new ReactiveScore(score, file);

    reactive.on("file-change", () => {
      console.log(chalk.cyan("\n[tutti] Score changed, reloading..."));
    });

    reactive.on("reloaded", () => {
      void (async () => {
        try {
          const nextScore = reactive?.current;
          if (!nextScore) return;
          const nextRuntime = buildRuntime(nextScore, sharedSessions);
          const nextGraphConfig = extractGraphConfig(nextScore);
          const nextGraphRunner = nextGraphConfig
            ? nextRuntime.createGraph(nextGraphConfig)
            : undefined;
          const nextApp = await buildApp(
            nextRuntime,
            agentName,
            port,
            host,
            options.apiKey,
            studioDistDir,
            nextGraphConfig,
            nextGraphRunner,
            options.realtime === true ? nextScore : undefined,
          );

          await app.close();
          runtime = nextRuntime;
          app = nextApp;
          await app.listen({ port, host });

          console.log(chalk.green("[tutti] Score reloaded. Server restarted."));
        } catch (err) {
          logger.error(
            { error: err instanceof Error ? err.message : String(err) },
            "[tutti] Reload failed — server continues with previous config",
          );
        }
      })();
    });

    reactive.on("reload-failed", (err) => {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        "[tutti] Reload failed — server continues with previous config",
      );
    });
  }

  // ── Start listening ─────────────────────────────────────────
  await app.listen({ port, host });

  printBanner(
    port,
    host,
    agentName,
    score,
    file,
    options.watch,
    studioDistDir !== undefined,
    options.realtime === true,
  );

  // ── Graceful shutdown ───────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    console.log(chalk.dim("\n" + signal + " received — shutting down..."));
    if (reactive) await reactive.close();
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// ── Helpers ──────────────────────────────────────────────────

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    logger.error({ port: raw }, "Invalid port number");
    process.exit(1);
  }
  return n;
}

function buildRuntime(
  score: ScoreConfig,
  sessionStore: SessionStore | undefined,
): TuttiRuntime {
  return new TuttiRuntime(
    score,
    sessionStore ? { sessionStore } : {},
  );
}

async function buildApp(
  runtime: TuttiRuntime,
  agentName: string,
  port: number,
  host: string,
  apiKey: string | undefined,
  studioDistDir: string | undefined,
  graph: GraphConfig | undefined,
  graphRunner: TuttiGraph | undefined,
  realtimeScore: ScoreConfig | undefined,
): Promise<FastifyInstance> {
  return createServer({
    port,
    host,
    runtime,
    agent_name: agentName,
    api_key: apiKey,
    ...(studioDistDir !== undefined ? { studio_dist_dir: studioDistDir } : {}),
    ...(graph !== undefined ? { graph } : {}),
    ...(graphRunner !== undefined ? { graph_runner: graphRunner } : {}),
    ...(realtimeScore !== undefined ? { realtime: true, score: realtimeScore } : {}),
  });
}

function printBanner(
  port: number,
  host: string,
  agentName: string,
  score: ScoreConfig,
  file: string,
  watch: boolean | undefined,
  studioEnabled: boolean,
  realtimeEnabled: boolean,
): void {
  const display = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  const url = "http://" + display + ":" + port;

  console.log();
  console.log(chalk.bold("  Tutti Server v" + SERVER_VERSION));
  console.log(chalk.dim("  " + url));
  console.log();
  console.log(chalk.dim("  Score:  ") + (score.name ?? file));
  console.log(chalk.dim("  Agent:  ") + agentName);
  console.log(chalk.dim("  Agents: ") + Object.keys(score.agents).join(", "));
  if (watch) {
    console.log(chalk.dim("  Watch:  ") + chalk.cyan("enabled"));
  }
  console.log();
  console.log(chalk.dim("  Endpoints:"));
  console.log(chalk.dim("    POST  ") + url + "/run");
  console.log(chalk.dim("    POST  ") + url + "/run/stream");
  console.log(chalk.dim("    GET   ") + url + "/sessions/:id");
  console.log(chalk.dim("    GET   ") + url + "/health");
  if (realtimeEnabled) {
    console.log(chalk.dim("    GET   ") + url + "/realtime  " + chalk.dim("(WebSocket)"));
    console.log(chalk.dim("    GET   ") + url + "/realtime-demo");
  }
  if (studioEnabled) {
    console.log();
    console.log(chalk.bold("  Studio available at " + url + "/studio"));
  }
  if (realtimeEnabled) {
    console.log();
    console.log(chalk.bold("  Realtime demo at " + url + "/realtime-demo"));
  }
  console.log();
}
