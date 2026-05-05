/**
 * `tutti-ai analyze costs`, `tutti-ai report costs`, and
 * `tutti-ai budgets` — CLI commands that talk to a running
 * `tutti-ai serve` process and render the cost-analysis output.
 *
 * Mirrors the pattern in `traces.ts`: this module owns HTTP fetching,
 * connection-error explanation, and exit-code handling; pure
 * formatting lives in `cost-render.ts` for testability.
 */

import chalk from "chalk";
import { SecretsManager } from "@tuttiai/core";
import {
  parseLastWindow,
  renderAnalyze,
  renderBudgets,
  renderReportCsv,
  renderReportJson,
  renderReportText,
  type AgentBudget,
  type CostRun,
  type ToolsResponse,
} from "./cost-render.js";

const DEFAULT_SERVER_URL = "http://127.0.0.1:3847";

/** Common options for every cost command. */
export interface CostOptions {
  url?: string;
  apiKey?: string;
}

/** Options for `analyze costs`. */
export interface AnalyzeCostsOptions extends CostOptions {
  /** `--last 7d` / `--last 12h`. Defaults to 7d. */
  last?: string;
  /** `--agent <id>` filter. */
  agent?: string;
}

/** Options for `report costs`. */
export interface ReportCostsOptions extends CostOptions {
  last?: string;
  agent?: string;
  format?: "text" | "json" | "csv";
}

/** Options for `budgets`. */
export interface BudgetsOptions extends CostOptions {
  agent?: string;
}

function resolveUrl(opts: CostOptions): string {
  return opts.url ?? SecretsManager.optional("TUTTI_SERVER_URL") ?? DEFAULT_SERVER_URL;
}

function resolveAuthHeader(opts: CostOptions): Record<string, string> {
  const key = opts.apiKey ?? SecretsManager.optional("TUTTI_API_KEY");
  return key ? { Authorization: "Bearer " + key } : {};
}

function explainConnectionError(err: unknown, baseUrl: string): never {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(chalk.red("Failed to reach Tutti server at " + baseUrl));
  console.error(chalk.dim("  " + msg));
  console.error(chalk.dim("  Is `tutti-ai serve` running? Set --url or TUTTI_SERVER_URL to override."));
  process.exit(1);
}

function handleNonOk(res: Response): void {
  if (res.status === 401) {
    console.error(chalk.red("Unauthorized — set --api-key or TUTTI_API_KEY."));
    process.exit(1);
  }
  if (!res.ok) {
    console.error(chalk.red("Server returned " + res.status + " " + res.statusText));
    process.exit(1);
  }
}

interface CostRunsBody {
  since: string | null;
  until: string | null;
  agent_id: string | null;
  store_missing: boolean;
  runs: CostRun[];
}

interface CostBudgetsBody {
  agents: AgentBudget[];
}

async function fetchRuns(
  baseUrl: string,
  opts: CostOptions,
  query: { since: Date; agent?: string; limit?: number },
): Promise<CostRunsBody> {
  const params = new URLSearchParams();
  params.set("since", query.since.toISOString());
  if (query.agent !== undefined) params.set("agent_id", query.agent);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const url = baseUrl.replace(/\/$/, "") + "/cost/runs?" + params.toString();
  let res: Response;
  try {
    res = await fetch(url, { headers: resolveAuthHeader(opts) });
  } catch (err) {
    explainConnectionError(err, baseUrl);
  }
  handleNonOk(res);
  return (await res.json()) as CostRunsBody;
}

async function fetchTools(
  baseUrl: string,
  opts: CostOptions,
): Promise<ToolsResponse | undefined> {
  const url = baseUrl.replace(/\/$/, "") + "/cost/tools";
  let res: Response;
  try {
    res = await fetch(url, { headers: resolveAuthHeader(opts) });
  } catch {
    // Live tracer data is best-effort — failure is non-fatal so the
    // analyze command still runs (and the user still sees the
    // persistent run-cost data plus hint #3).
    return undefined;
  }
  if (!res.ok) return undefined;
  return (await res.json()) as ToolsResponse;
}

async function fetchBudgets(
  baseUrl: string,
  opts: CostOptions,
  agent?: string,
): Promise<CostBudgetsBody> {
  const params = new URLSearchParams();
  if (agent !== undefined) params.set("agent_id", agent);
  const qs = params.toString();
  const url = baseUrl.replace(/\/$/, "") + "/cost/budgets" + (qs ? "?" + qs : "");
  let res: Response;
  try {
    res = await fetch(url, { headers: resolveAuthHeader(opts) });
  } catch (err) {
    explainConnectionError(err, baseUrl);
  }
  if (res.status === 404) {
    console.error(chalk.red('Agent "' + (agent ?? "?") + '" not found in this score.'));
    process.exit(1);
  }
  handleNonOk(res);
  return (await res.json()) as CostBudgetsBody;
}

function resolveSince(last: string | undefined, fallbackDays: number): Date {
  if (last === undefined) return new Date(Date.now() - fallbackDays * 86_400_000);
  const parsed = parseLastWindow(last);
  if (!parsed) {
    console.error(
      chalk.red('Invalid --last value: "' + last + '". Expected `<N>d` or `<N>h`, e.g. `7d` or `12h`.'),
    );
    process.exit(1);
  }
  return parsed;
}

// ── analyze costs ─────────────────────────────────────────────

export async function analyzeCostsCommand(opts: AnalyzeCostsOptions): Promise<void> {
  const baseUrl = resolveUrl(opts);
  const since = resolveSince(opts.last, 7);
  const runsBody = await fetchRuns(baseUrl, opts, {
    since,
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    limit: 1000,
  });
  const budgetsBody = await fetchBudgets(baseUrl, opts, opts.agent);
  const tools = await fetchTools(baseUrl, opts);
  console.log(
    renderAnalyze({
      runs: runsBody.runs,
      since,
      budgets: budgetsBody.agents,
      ...(tools !== undefined ? { tools } : {}),
      ...(opts.agent !== undefined ? { agent_id: opts.agent } : {}),
      store_missing: runsBody.store_missing,
    }),
  );
}

// ── report costs ──────────────────────────────────────────────

export async function reportCostsCommand(opts: ReportCostsOptions): Promise<void> {
  const baseUrl = resolveUrl(opts);
  const since = resolveSince(opts.last, 7);
  const runsBody = await fetchRuns(baseUrl, opts, {
    since,
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    limit: 10_000,
  });

  const format = opts.format ?? "text";
  const input = {
    runs: runsBody.runs,
    since,
    ...(opts.agent !== undefined ? { agent_id: opts.agent } : {}),
  };
  if (format === "json") {
    console.log(renderReportJson(input));
    return;
  }
  if (format === "csv") {
    console.log(renderReportCsv(input));
    return;
  }
  console.log(renderReportText(input));
}

// ── budgets ───────────────────────────────────────────────────

export async function budgetsCommand(opts: BudgetsOptions): Promise<void> {
  const baseUrl = resolveUrl(opts);
  const body = await fetchBudgets(baseUrl, opts, opts.agent);
  console.log(renderBudgets(body.agents));
}
