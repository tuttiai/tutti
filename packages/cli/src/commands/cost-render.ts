/**
 * Pure rendering helpers for the cost-analysis CLI commands
 * (`analyze costs`, `report costs`, `budgets`).
 *
 * Split from the command modules so the formatting logic stays in the
 * coverage scope while HTTP fetching and exit-code handling stay
 * excluded — same pattern as `traces-render.ts`.
 */

import chalk from "chalk";

/** Wire shape of one row from `GET /cost/runs`. */
export interface CostRun {
  run_id: string;
  agent_name: string;
  /** ISO-8601 string. */
  started_at: string;
  cost_usd: number;
  total_tokens: number;
}

/** Wire shape of one row from `GET /cost/tools`. */
export interface ToolUsage {
  tool_name: string;
  call_count: number;
  total_llm_tokens: number;
  avg_llm_tokens_per_call: number;
}

/** Wire shape of `GET /cost/tools`. */
export interface ToolsResponse {
  /** ISO-8601 timestamp of the earliest span in the live tracer window. */
  window_started_at: string;
  /** Total spans the live tracer is currently holding. */
  window_span_count: number;
  tools: ToolUsage[];
}

/** Wire shape of one row from `GET /cost/budgets`. */
export interface AgentBudget {
  agent_id: string;
  budget?: {
    max_tokens?: number;
    max_cost_usd?: number;
    max_cost_usd_per_day?: number;
    max_cost_usd_per_month?: number;
    warn_at_percent?: number;
  };
  daily_total_usd: number | null;
  monthly_total_usd: number | null;
}

/** Sparkline glyphs ordered low → high. */
const SPARK_BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/**
 * Render a one-line unicode sparkline from a sequence of non-negative
 * values. Returns an empty string for an empty input.
 *
 * Each value is mapped to one of the eight bar glyphs proportional to
 * `value / max`. A flat zero series renders as the lowest glyph
 * everywhere so the length still communicates the bucket count.
 */
export function sparkline(values: readonly number[]): string {
  if (values.length === 0) return "";
  const max = values.reduce((a, b) => (b > a ? b : a), 0);
  if (max <= 0) return SPARK_BARS[0]!.repeat(values.length);
  return values
    .map((v) => {
      const idx = Math.min(
        SPARK_BARS.length - 1,
        Math.max(0, Math.floor((v / max) * (SPARK_BARS.length - 1) + 0.5)),
      );
      return SPARK_BARS[idx]!;
    })
    .join("");
}

/**
 * Bucket runs by UTC day between `since` and `until` (half-open) and
 * return a dense array of bucket totals. Days with no runs surface as
 * `0` so the sparkline shows gaps rather than collapsing them.
 *
 * @param runs - Records from `/cost/runs`.
 * @param since - Lower bound (inclusive). The first bucket starts at
 *   the UTC-day floor of this timestamp.
 * @param until - Upper bound (exclusive). Defaults to "now".
 */
export function bucketByDay(
  runs: readonly CostRun[],
  since: Date,
  until: Date = new Date(),
): number[] {
  const dayMs = 24 * 60 * 60 * 1000;
  const start = Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate());
  const end = Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), until.getUTCDate()) + dayMs;
  const bucketCount = Math.max(1, Math.round((end - start) / dayMs));
  const buckets = new Array<number>(bucketCount).fill(0);
  for (const r of runs) {
    const t = Date.parse(r.started_at);
    if (!Number.isFinite(t)) continue;
    if (t < start || t >= end) continue;
    const idx = Math.min(bucketCount - 1, Math.floor((t - start) / dayMs));
    buckets[idx] = (buckets[idx] ?? 0) + r.cost_usd;
  }
  return buckets;
}

function formatCost(cost: number): string {
  if (cost === 0) return "$0";
  if (cost < 0.01) return "$" + cost.toFixed(6);
  return "$" + cost.toFixed(4);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function formatDate(iso: string): string {
  // 2026-04-15T12:34:56.789Z → 2026-04-15 12:34
  return iso.slice(0, 10) + " " + iso.slice(11, 16);
}

function visibleLen(s: string): number {
  return s.replace(/\[[0-9;]*m/g, "").length;
}

function pad(s: string, len: number): string {
  const v = visibleLen(s);
  return v >= len ? s : s + " ".repeat(len - v);
}

/**
 * Render the top-N expensive runs as a fixed-width table.
 *
 * `runs` is expected to be pre-sorted by cost desc — the renderer
 * preserves the input order so callers can sort by other dimensions
 * (recency, agent) without changing the layout.
 */
export function renderTopRuns(runs: readonly CostRun[], limit = 10): string {
  if (runs.length === 0) return chalk.dim("No runs in this window.");
  const lines: string[] = [];
  lines.push(
    chalk.dim(
      "  " +
        pad("RUN", 10) +
        pad("AGENT", 18) +
        pad("STARTED", 18) +
        pad("TOKENS", 10) +
        "COST",
    ),
  );
  lines.push(chalk.dim("  " + "─".repeat(70)));
  for (const r of runs.slice(0, limit)) {
    lines.push(
      "  " +
        chalk.bold(pad(r.run_id.slice(0, 8), 10)) +
        pad(r.agent_name, 18) +
        pad(formatDate(r.started_at), 18) +
        pad(formatTokens(r.total_tokens), 10) +
        formatCost(r.cost_usd),
    );
  }
  return lines.join("\n");
}

/**
 * Heuristic-based optimisation hints derived from the run history.
 *
 * Tier 1 ships only the burn-rate hint because the others (tool-call
 * frequency, model-vs-input-size) need span data. The signature is
 * already shaped to receive that data in Tier 2 without changing the
 * call site.
 */
export interface HintInputs {
  /** Records returned from `/cost/runs` for the analysis window. */
  runs: readonly CostRun[];
  /** Lower bound of the window, inclusive. */
  since: Date;
  /** Upper bound of the window, exclusive. Defaults to "now". */
  until?: Date;
  /** Agent budgets to compare burn rate against. */
  budgets?: readonly AgentBudget[];
  /** Tool-usage rows from the live tracer window. Optional — when absent
   *  only the burn-rate hint can fire. */
  tools?: ToolsResponse;
}

/** Plain-text optimisation hint surfaced in `analyze costs` output. */
export interface Hint {
  /** Stable id for tests and dashboards. */
  id: string;
  /** One-line rendered message (no ANSI codes). */
  message: string;
}

/**
 * Compute the burn-rate hint: `at $X/day, you'll hit your $Y monthly cap
 * in N days`. Returns one hint per agent with a `max_cost_usd_per_month`
 * configured AND a non-trivial daily average.
 *
 * Pure — no I/O. Tests feed mock inputs and assert on the resulting
 * hint list.
 */
export function buildHints({
  runs,
  since,
  until = new Date(),
  budgets = [],
  tools,
}: HintInputs): Hint[] {
  const hints: Hint[] = [];

  const windowDays = Math.max(1, (until.getTime() - since.getTime()) / 86_400_000);
  const totalCost = runs.reduce((acc, r) => acc + r.cost_usd, 0);
  const dailyAvg = totalCost / windowDays;

  for (const b of budgets) {
    const monthly = b.budget?.max_cost_usd_per_month;
    if (monthly === undefined || monthly <= 0) continue;
    if (dailyAvg <= 0) continue;
    const monthlySoFar = b.monthly_total_usd ?? 0;
    const remaining = Math.max(0, monthly - monthlySoFar);
    if (remaining === 0) {
      hints.push({
        id: "budget.month-exhausted." + b.agent_id,
        message: `Agent "${b.agent_id}" has already used $${monthlySoFar.toFixed(2)} of its $${monthly.toFixed(2)} monthly budget — further runs will throw BudgetExceededError.`,
      });
      continue;
    }
    const daysLeft = remaining / dailyAvg;
    hints.push({
      id: "budget.burn-rate." + b.agent_id,
      message: `Agent "${b.agent_id}" is burning $${dailyAvg.toFixed(4)}/day on average — at this rate the monthly $${monthly.toFixed(2)} cap will be hit in ~${daysLeft.toFixed(1)} days.`,
    });
  }

  if (tools && tools.tools.length > 0) {
    // Hint 1 — caching: surface tools called frequently in the live
    // window. Fires on the most-used tool when its call_count clears the
    // threshold; the user can then enable AgentCacheConfig.
    const TOOL_CACHE_HINT_THRESHOLD = 10;
    const top = tools.tools[0];
    if (top && top.call_count >= TOOL_CACHE_HINT_THRESHOLD) {
      hints.push({
        id: "tool.frequent-calls." + top.tool_name,
        message: `Tool "${top.tool_name}" was called ${top.call_count} times in the live tracer window (since ${tools.window_started_at.slice(0, 16)}). Repeated identical calls — consider enabling \`cache: { enabled: true }\` on the agent.`,
      });
    }

    // Hint 2 — model: auto: when most live calls are short (low average
    // tokens per LLM call) yet the run cost is non-trivial, suggest
    // routing. Threshold mirrors the heuristic classifier's "small" tier
    // boundary (~200 input tokens, ≤4 tools).
    const MODEL_AUTO_TOKEN_THRESHOLD = 800;
    const totalCalls = tools.tools.reduce((a, t) => a + t.call_count, 0);
    const cheapCalls = tools.tools.filter(
      (t) => t.avg_llm_tokens_per_call > 0 && t.avg_llm_tokens_per_call < MODEL_AUTO_TOKEN_THRESHOLD,
    ).reduce((a, t) => a + t.call_count, 0);
    if (totalCalls > 0 && cheapCalls / totalCalls >= 0.6 && totalCost > 0) {
      const pct = Math.round((cheapCalls / totalCalls) * 100);
      hints.push({
        id: "model.auto-suggestion",
        message: `${pct}% of recent tool-driven turns ran on small inputs (<${MODEL_AUTO_TOKEN_THRESHOLD} avg tokens/call). Consider \`model: 'auto'\` plus a SmartProvider so cheap turns route to a smaller tier.`,
      });
    }
  }

  return hints;
}

/**
 * Render the top-N tools by call count from the live tracer window.
 *
 * Always prefixes the table with a one-line caveat naming the window
 * boundary (since-server-boot, span count). Without the caveat users
 * read these numbers as authoritative all-time totals — they're not.
 */
export function renderTopTools(input: ToolsResponse, limit = 5): string {
  const lines: string[] = [];
  lines.push(
    chalk.dim(
      "  Live window: " +
        input.window_span_count +
        " spans collected since " +
        input.window_started_at.slice(0, 16),
    ),
  );
  if (input.tools.length === 0) {
    lines.push(chalk.dim("  No tool calls in this window."));
    return lines.join("\n");
  }
  lines.push(
    chalk.dim(
      "  " +
        pad("TOOL", 24) +
        pad("CALLS", 10) +
        pad("AVG TOK/CALL", 16) +
        "TOTAL TOKENS",
    ),
  );
  lines.push(chalk.dim("  " + "─".repeat(70)));
  for (const t of input.tools.slice(0, limit)) {
    lines.push(
      "  " +
        chalk.bold(pad(t.tool_name, 24)) +
        pad(String(t.call_count), 10) +
        pad(formatTokens(Math.round(t.avg_llm_tokens_per_call)), 16) +
        formatTokens(t.total_llm_tokens),
    );
  }
  return lines.join("\n");
}

/** Render hints as a bulleted list, dimmed when empty. */
export function renderHints(hints: readonly Hint[]): string {
  if (hints.length === 0) return chalk.dim("No optimisation hints.");
  return hints.map((h) => chalk.yellow("• ") + h.message).join("\n");
}

/**
 * Top-level renderer for `analyze costs` — composes the table, the
 * sparkline header, the totals footer, and the hint list into one
 * string the caller can `console.log`.
 */
export function renderAnalyze(input: {
  runs: readonly CostRun[];
  since: Date;
  until?: Date;
  budgets?: readonly AgentBudget[];
  /** Optional tool-usage data from `/cost/tools`. When provided, an
   *  extra "Top tools" section renders, framed as a live tracer
   *  window. */
  tools?: ToolsResponse;
  agent_id?: string;
  store_missing?: boolean;
}): string {
  if (input.store_missing === true) {
    return chalk.yellow(
      "No RunCostStore configured on the server — start `tutti-ai serve` with a store to enable cost analysis.",
    );
  }
  const lines: string[] = [];
  const totalCost = input.runs.reduce((a, r) => a + r.cost_usd, 0);
  const totalTokens = input.runs.reduce((a, r) => a + r.total_tokens, 0);
  const totalRuns = input.runs.length;

  const header =
    "Cost analysis " +
    (input.agent_id !== undefined ? "for agent " + chalk.bold(input.agent_id) + " " : "") +
    "since " +
    chalk.bold(input.since.toISOString().slice(0, 10));
  lines.push("");
  lines.push(chalk.bold(header));

  if (totalRuns === 0) {
    lines.push(chalk.dim("No runs in this window."));
    lines.push("");
    return lines.join("\n");
  }

  // Daily sparkline.
  const buckets = bucketByDay(input.runs, input.since, input.until);
  lines.push(
    "Daily spend: " + chalk.cyan(sparkline(buckets)) + chalk.dim(" (" + buckets.length + " days)"),
  );
  lines.push(
    "Total: " +
      chalk.bold(formatCost(totalCost)) +
      chalk.dim(" · ") +
      formatTokens(totalTokens) +
      chalk.dim(" tokens · ") +
      String(totalRuns) +
      chalk.dim(" runs"),
  );
  lines.push("");
  lines.push(chalk.bold("Top runs by cost"));

  const sorted = [...input.runs].sort((a, b) => b.cost_usd - a.cost_usd);
  lines.push(renderTopRuns(sorted, 10));

  if (input.tools !== undefined) {
    lines.push("");
    lines.push(chalk.bold("Top tools (live window)"));
    lines.push(renderTopTools(input.tools, 5));
  }

  const hints = buildHints({
    runs: input.runs,
    since: input.since,
    ...(input.until !== undefined ? { until: input.until } : {}),
    budgets: input.budgets ?? [],
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
  });
  lines.push("");
  lines.push(chalk.bold("Hints"));
  lines.push(renderHints(hints));
  lines.push("");
  return lines.join("\n");
}

/**
 * Render the budgets command output: per-agent budget config alongside
 * the current daily and monthly spend.
 */
export function renderBudgets(agents: readonly AgentBudget[]): string {
  if (agents.length === 0) {
    return chalk.dim("No agents have a budget configured.");
  }
  const lines: string[] = [];
  for (const a of agents) {
    lines.push(chalk.bold("Agent: ") + a.agent_id);
    if (!a.budget) {
      lines.push("  " + chalk.dim("(no budget configured)"));
      lines.push("");
      continue;
    }
    const b = a.budget;
    if (b.max_cost_usd !== undefined) {
      lines.push("  " + pad("Per-run budget:", 22) + chalk.bold(formatCost(b.max_cost_usd)));
    }
    if (b.max_cost_usd_per_day !== undefined) {
      const cur = a.daily_total_usd;
      const pct = cur !== null ? (cur / b.max_cost_usd_per_day) * 100 : null;
      lines.push(
        "  " +
          pad("Daily budget:", 22) +
          chalk.bold(formatCost(b.max_cost_usd_per_day)) +
          chalk.dim(" | today: ") +
          (cur !== null ? formatCost(cur) : chalk.dim("—")) +
          (pct !== null ? chalk.dim(" (" + pct.toFixed(1) + "%)") : ""),
      );
    }
    if (b.max_cost_usd_per_month !== undefined) {
      const cur = a.monthly_total_usd;
      const pct = cur !== null ? (cur / b.max_cost_usd_per_month) * 100 : null;
      lines.push(
        "  " +
          pad("Monthly budget:", 22) +
          chalk.bold(formatCost(b.max_cost_usd_per_month)) +
          chalk.dim(" | this month: ") +
          (cur !== null ? formatCost(cur) : chalk.dim("—")) +
          (pct !== null ? chalk.dim(" (" + pct.toFixed(1) + "%)") : ""),
      );
    }
    if (b.max_tokens !== undefined) {
      lines.push("  " + pad("Token cap (per run):", 22) + chalk.bold(formatTokens(b.max_tokens)));
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ── report formatters ────────────────────────────────────────

export interface ReportInput {
  runs: readonly CostRun[];
  since: Date;
  until?: Date;
  agent_id?: string;
}

/** Render a `report costs --format text` summary. */
export function renderReportText(input: ReportInput): string {
  if (input.runs.length === 0) return "No runs in this window.";
  const totalCost = input.runs.reduce((a, r) => a + r.cost_usd, 0);
  const totalTokens = input.runs.reduce((a, r) => a + r.total_tokens, 0);
  const byAgent = new Map<string, { cost: number; tokens: number; runs: number }>();
  for (const r of input.runs) {
    const a = byAgent.get(r.agent_name) ?? { cost: 0, tokens: 0, runs: 0 };
    a.cost += r.cost_usd;
    a.tokens += r.total_tokens;
    a.runs += 1;
    byAgent.set(r.agent_name, a);
  }
  const lines: string[] = [];
  lines.push(
    "Cost report — " +
      input.since.toISOString().slice(0, 10) +
      " to " +
      (input.until ?? new Date()).toISOString().slice(0, 10),
  );
  if (input.agent_id !== undefined) lines.push("Agent: " + input.agent_id);
  lines.push("");
  lines.push("Total runs:   " + input.runs.length);
  lines.push("Total tokens: " + totalTokens.toLocaleString());
  lines.push("Total cost:   " + formatCost(totalCost));
  lines.push("");
  lines.push("By agent:");
  for (const [name, a] of byAgent) {
    lines.push(
      "  " +
        pad(name, 24) +
        pad(String(a.runs) + " runs", 12) +
        pad(formatTokens(a.tokens), 10) +
        formatCost(a.cost),
    );
  }
  return lines.join("\n");
}

/** Render a `report costs --format json` body. */
export function renderReportJson(input: ReportInput): string {
  const totalCost = input.runs.reduce((a, r) => a + r.cost_usd, 0);
  const totalTokens = input.runs.reduce((a, r) => a + r.total_tokens, 0);
  return (
    JSON.stringify(
      {
        since: input.since.toISOString(),
        until: (input.until ?? new Date()).toISOString(),
        ...(input.agent_id !== undefined ? { agent_id: input.agent_id } : {}),
        totals: {
          runs: input.runs.length,
          total_tokens: totalTokens,
          cost_usd: totalCost,
        },
        runs: input.runs,
      },
      null,
      2,
    )
  );
}

/** Render a `report costs --format csv` body — header + one row per run. */
export function renderReportCsv(input: ReportInput): string {
  const header = "run_id,agent_name,started_at,total_tokens,cost_usd";
  const rows = input.runs.map((r) =>
    [
      escapeCsv(r.run_id),
      escapeCsv(r.agent_name),
      escapeCsv(r.started_at),
      String(r.total_tokens),
      String(r.cost_usd),
    ].join(","),
  );
  return [header, ...rows].join("\n");
}

function escapeCsv(value: string): string {
  if (/[",\n]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

// ── --last parsing ─────────────────────────────────────────────

/**
 * Parse a `--last <N>d|h` argument into a `Date` representing the lower
 * bound. Returns `null` for unparseable input so callers can surface a
 * friendly error.
 *
 * Examples: `7d` → 7 days ago, `12h` → 12 hours ago.
 */
export function parseLastWindow(input: string, now: Date = new Date()): Date | null {
  const match = /^(\d+)([dh])$/.exec(input.trim());
  if (!match) return null;
  const n = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unitMs = match[2] === "h" ? 3_600_000 : 86_400_000;
  return new Date(now.getTime() - n * unitMs);
}
