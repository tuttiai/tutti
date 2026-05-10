/**
 * `tutti-ai traces <subcommand>` — list, show, and tail traces emitted
 * by a running `tutti-ai serve` process.
 *
 * All three subcommands talk to the server's `/traces` route family.
 * The CLI never reads spans from a local tracer because traces are
 * per-process and the CLI runs in a separate process from the agent.
 */

import chalk from "chalk";
import { SecretsManager } from "@tuttiai/core";
import type { TraceSummary, TuttiSpan } from "@tuttiai/core";

import {
  isRouterSpan,
  renderRouterSummary,
  renderSpanLine,
  renderTraceShow,
  renderTracesList,
} from "./traces-render.js";

const DEFAULT_SERVER_URL = "http://127.0.0.1:3847";

/** Common command-line options shared by all three subcommands. */
export interface TracesOptions {
  /** Base URL of the `tutti-ai serve` process. Defaults to localhost:3847. */
  url?: string;
  /** Bearer token. Falls back to TUTTI_API_KEY env var. */
  apiKey?: string;
}

function resolveUrl(opts: TracesOptions): string {
  return opts.url ?? SecretsManager.optional("TUTTI_SERVER_URL") ?? DEFAULT_SERVER_URL;
}

function resolveAuthHeader(opts: TracesOptions): Record<string, string> {
  const key = opts.apiKey ?? SecretsManager.optional("TUTTI_API_KEY");
  return key ? { Authorization: "Bearer " + key } : {};
}

function explainConnectionError(err: unknown, baseUrl: string): never {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(chalk.red("Failed to reach Tutti server at " + baseUrl));
  console.error(chalk.dim("  " + msg));
  console.error(chalk.dim('  Is `tutti-ai serve` running? Set --url or TUTTI_SERVER_URL to override.'));
  process.exit(1);
}

// ── list ──────────────────────────────────────────────────────

export async function tracesListCommand(opts: TracesOptions): Promise<void> {
  const baseUrl = resolveUrl(opts);
  const url = baseUrl.replace(/\/$/, "") + "/traces";
  let res: Response;
  try {
    res = await fetch(url, { headers: resolveAuthHeader(opts) });
  } catch (err) {
    explainConnectionError(err, baseUrl);
  }

  if (res.status === 401) {
    console.error(chalk.red("Unauthorized — set --api-key or TUTTI_API_KEY."));
    process.exit(1);
  }
  if (!res.ok) {
    console.error(chalk.red("Server returned " + res.status + " " + res.statusText));
    process.exit(1);
  }

  const body = (await res.json()) as { traces: TraceSummary[] };
  console.log(renderTracesList(body.traces));
}

// ── show ──────────────────────────────────────────────────────

export async function tracesShowCommand(
  traceId: string,
  opts: TracesOptions,
): Promise<void> {
  const baseUrl = resolveUrl(opts);
  const url = baseUrl.replace(/\/$/, "") + "/traces/" + encodeURIComponent(traceId);
  let res: Response;
  try {
    res = await fetch(url, { headers: resolveAuthHeader(opts) });
  } catch (err) {
    explainConnectionError(err, baseUrl);
  }

  if (res.status === 404) {
    console.error(chalk.red('Trace "' + traceId + '" not found.'));
    process.exit(1);
  }
  if (res.status === 401) {
    console.error(chalk.red("Unauthorized — set --api-key or TUTTI_API_KEY."));
    process.exit(1);
  }
  if (!res.ok) {
    console.error(chalk.red("Server returned " + res.status + " " + res.statusText));
    process.exit(1);
  }

  const body = (await res.json()) as { trace_id: string; spans: TuttiSpan[] };
  // Dates round-trip as ISO strings; the renderer expects Date objects.
  const spans = body.spans.map(reviveSpanDates);
  console.log(renderTraceShow(spans));
}

// ── router (one-shot summary) ─────────────────────────────────

/**
 * Fetch a single trace and render only its `@tuttiai/router` decisions
 * — chosen tier, classifier, model, and cost per call, plus any fallback
 * arrows. Useful for "what tier did the router pick on every call of
 * this run, and how much did it think the run would cost?".
 */
export async function tracesRouterCommand(
  traceId: string,
  opts: TracesOptions,
): Promise<void> {
  const baseUrl = resolveUrl(opts);
  const url = baseUrl.replace(/\/$/, "") + "/traces/" + encodeURIComponent(traceId);
  let res: Response;
  try {
    res = await fetch(url, { headers: resolveAuthHeader(opts) });
  } catch (err) {
    explainConnectionError(err, baseUrl);
  }

  if (res.status === 404) {
    console.error(chalk.red('Trace "' + traceId + '" not found.'));
    process.exit(1);
  }
  if (res.status === 401) {
    console.error(chalk.red("Unauthorized — set --api-key or TUTTI_API_KEY."));
    process.exit(1);
  }
  if (!res.ok) {
    console.error(chalk.red("Server returned " + res.status + " " + res.statusText));
    process.exit(1);
  }

  const body = (await res.json()) as { trace_id: string; spans: TuttiSpan[] };
  const spans = body.spans.map(reviveSpanDates);
  console.log(renderRouterSummary(spans));
}

// ── tail ──────────────────────────────────────────────────────

/** Extra options for `traces tail` beyond the shared connection settings. */
export interface TracesTailOptions extends TracesOptions {
  /** When true, suppress every span that doesn't carry router_* attributes. */
  routerOnly?: boolean;
}

export async function tracesTailCommand(opts: TracesTailOptions): Promise<void> {
  const baseUrl = resolveUrl(opts);
  const url = baseUrl.replace(/\/$/, "") + "/traces/stream";

  console.error(chalk.dim("Tailing traces from " + baseUrl + " — Ctrl+C to exit"));
  console.error("");

  const controller = new AbortController();
  process.once("SIGINT", () => {
    controller.abort();
    console.error("");
    console.error(chalk.dim("Disconnected."));
    process.exit(0);
  });

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { ...resolveAuthHeader(opts), Accept: "text/event-stream" },
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) return;
    explainConnectionError(err, baseUrl);
  }

  if (res.status === 401) {
    console.error(chalk.red("Unauthorized — set --api-key or TUTTI_API_KEY."));
    process.exit(1);
  }
  if (!res.ok || !res.body) {
    console.error(chalk.red("Server returned " + res.status + " " + res.statusText));
    process.exit(1);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      // Aborted via SIGINT.
      return;
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });

    let frameEnd: number;
    while ((frameEnd = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      try {
        const span = reviveSpanDates(JSON.parse(dataLine.slice(6)) as TuttiSpan);
        if (opts.routerOnly && !isRouterSpan(span)) continue;
        console.log(renderSpanLine(span, 0));
      } catch (err) {
        console.error(chalk.red("Bad SSE frame: " + (err instanceof Error ? err.message : String(err))));
      }
    }
  }
}

/**
 * Convert ISO date strings on a wire-format span back to `Date` objects
 * so the render functions can call `.getTime()` etc.
 */
function reviveSpanDates(span: TuttiSpan): TuttiSpan {
  return {
    ...span,
    started_at: new Date(span.started_at),
    ...(span.ended_at !== undefined
      ? { ended_at: new Date(span.ended_at) }
      : {}),
  };
}
