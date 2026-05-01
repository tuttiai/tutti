/**
 * Pure rendering functions for the `tutti-ai traces` command.
 *
 * Split from `traces.ts` so they stay in the coverage scope while the
 * HTTP fetching, SSE consumption, and signal handling stay excluded.
 */

import chalk from "chalk";
import type {
  SpanKind,
  SpanStatus,
  TraceSummary,
  TuttiSpan,
} from "@tuttiai/core";

/** Visible width of an ANSI-coloured string. */
function visibleLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "").length;
}

/** Right-pad to `len` accounting for ANSI escape sequences. */
function pad(s: string, len: number): string {
  const v = visibleLen(s);
  return v >= len ? s : s + " ".repeat(len - v);
}

function colorStatus(status: SpanStatus): string {
  if (status === "ok") return chalk.green("ok");
  if (status === "error") return chalk.red("error");
  return chalk.yellow("running");
}

function formatCost(cost: number | null): string {
  if (cost === null) return chalk.dim("—");
  if (cost === 0) return "$0";
  // 6 decimals covers fractions of a cent on cheap models without
  // exploding the column width.
  return "$" + cost.toFixed(6);
}

function formatTokens(n: number): string {
  return n > 0 ? String(n) : chalk.dim("—");
}

function formatDuration(ms: number | null): string {
  if (ms === null) return chalk.dim("—");
  return ms + "ms";
}

/**
 * Render a list of trace summaries as a fixed-width table. Empty input
 * renders a friendly "no traces" message.
 *
 * Sort order is the caller's responsibility (server returns most-recent-
 * first); this function preserves the input order.
 */
export function renderTracesList(traces: readonly TraceSummary[]): string {
  if (traces.length === 0) {
    return chalk.dim("No traces found.");
  }

  const lines: string[] = [];
  lines.push("");
  lines.push(
    chalk.dim(
      "  " +
        pad("TRACE", 10) +
        pad("AGENT", 18) +
        pad("STARTED", 12) +
        pad("DURATION", 12) +
        pad("STATUS", 12) +
        pad("TOKENS", 10) +
        "COST",
    ),
  );
  lines.push(chalk.dim("  " + "─".repeat(80)));

  for (const t of traces) {
    const traceShort = t.trace_id.slice(0, 8);
    // ISO format: 2026-04-15T12:34:56.789Z → take HH:MM:SS slice.
    const startedShort = t.started_at.slice(11, 19);

    lines.push(
      "  " +
        chalk.bold(pad(traceShort, 10)) +
        pad(t.agent_id ?? chalk.dim("—"), 18) +
        pad(startedShort, 12) +
        pad(formatDuration(t.duration_ms), 12) +
        pad(colorStatus(t.status), 12) +
        pad(formatTokens(t.total_tokens), 10) +
        formatCost(t.cost_usd),
    );
  }
  lines.push("");
  return lines.join("\n");
}

/** Single-character icon per span kind. */
const SPAN_ICONS: Record<SpanKind, string> = {
  agent: "▶",
  llm: "◆",
  tool: "⚙",
  guardrail: "🛡",
  checkpoint: "💾",
};

/**
 * Render a single span line. Exported so `traces tail` can reuse the same
 * formatting for individual spans arriving over SSE.
 */
export function renderSpanLine(span: TuttiSpan, indent: number): string {
  const icon = SPAN_ICONS[span.kind];
  const indentStr = "  ".repeat(indent);
  const dur =
    span.duration_ms !== undefined
      ? chalk.dim(" " + span.duration_ms + "ms ")
      : chalk.dim(" (running) ");
  const status = colorStatus(span.status);
  const attrs = formatAttrs(span);
  const attrSuffix = attrs ? chalk.dim(" · " + attrs) : "";
  return indentStr + icon + " " + chalk.bold(span.name) + dur + status + attrSuffix;
}

/**
 * Returns `true` when the span carries any `router_*` attribute set by
 * `AgentRunner`'s `@tuttiai/router` event hooks. Cheap predicate used
 * by the live `traces tail --router-only` filter and by the one-shot
 * `traces router <trace-id>` summary renderer.
 */
export function isRouterSpan(span: TuttiSpan): boolean {
  const a = span.attributes;
  return (
    a.router_tier !== undefined ||
    a.router_model !== undefined ||
    a.router_classifier !== undefined ||
    a.router_reason !== undefined ||
    a.router_cost_estimate !== undefined ||
    a.router_fallback_from !== undefined ||
    a.router_fallback_to !== undefined ||
    a.router_fallback_error !== undefined
  );
}

/**
 * One-shot summary of every router decision recorded inside a single
 * trace. Filters to `llm.completion` spans that carry `router_*`
 * attributes and renders one row per decision plus a footer with the
 * total estimated routing cost. Renders a friendly empty message when
 * no router decisions are present (e.g. agent ran against a plain
 * provider, or the trace pre-dates v0.23.0).
 */
export function renderRouterSummary(spans: readonly TuttiSpan[]): string {
  const decisions = spans.filter((s) => s.name === "llm.completion" && isRouterSpan(s));
  if (decisions.length === 0) {
    return chalk.dim("No router decisions found in this trace.");
  }

  decisions.sort((a, b) => a.started_at.getTime() - b.started_at.getTime());

  const traceId = decisions[0]?.trace_id ?? "";
  const agentSpan = spans.find((s) => s.kind === "agent" && s.attributes.agent_id !== undefined);
  const agentLabel = agentSpan?.attributes.agent_id ?? chalk.dim("—");

  const lines: string[] = [""];
  lines.push(
    chalk.bold("Trace " + traceId.slice(0, 8)) +
      chalk.dim(" — agent: ") +
      agentLabel,
  );
  lines.push(chalk.dim("─".repeat(80)));
  lines.push(
    chalk.dim(
      "  " +
        pad("#", 4) +
        pad("TIER", 12) +
        pad("CLASSIFIER", 12) +
        pad("MODEL", 22) +
        pad("COST", 14) +
        "REASON",
    ),
  );
  lines.push(chalk.dim("  " + "─".repeat(78)));

  let totalCost = 0;
  let anyCost = false;
  for (let i = 0; i < decisions.length; i++) {
    const span = decisions[i];
    if (!span) continue;
    const a = span.attributes;
    const tier = a.router_tier ?? chalk.dim("—");
    const classifier = a.router_classifier ?? chalk.dim("—");
    const model = a.router_model ?? chalk.dim("—");
    const cost = a.router_cost_estimate;
    const reason = a.router_reason ?? chalk.dim("—");
    if (cost !== undefined) {
      totalCost += cost;
      anyCost = true;
    }

    lines.push(
      "  " +
        pad(String(i + 1) + ".", 4) +
        pad(colorTier(tier), 12) +
        pad(classifier, 12) +
        pad(model, 22) +
        pad(formatCost(cost ?? null), 14) +
        reason,
    );
    if (a.router_fallback_from !== undefined && a.router_fallback_to !== undefined) {
      const errMsg = a.router_fallback_error ?? "(no error message)";
      lines.push(
        "    " +
          chalk.dim("↩ ") +
          chalk.red(a.router_fallback_from + " → " + a.router_fallback_to) +
          chalk.dim('  "' + errMsg + '"'),
      );
    }
  }

  lines.push(chalk.dim("─".repeat(80)));
  lines.push(
    chalk.bold(decisions.length.toString()) +
      chalk.dim(" router decision" + (decisions.length === 1 ? "" : "s") + " · estimated ") +
      chalk.bold(anyCost ? formatCost(totalCost) : chalk.dim("—")) +
      chalk.dim(" routing cost"),
  );
  lines.push("");
  return lines.join("\n");
}

function colorTier(tier: string): string {
  if (tier === "small") return chalk.green(tier);
  if (tier === "medium") return chalk.yellow(tier);
  if (tier === "large") return chalk.magenta(tier);
  if (tier === "fallback") return chalk.red(tier);
  return tier;
}

function formatAttrs(span: TuttiSpan): string {
  const a = span.attributes;
  const parts: string[] = [];
  if (span.kind === "agent") {
    if (a.agent_id !== undefined) parts.push("agent=" + a.agent_id);
    if (a.model !== undefined) parts.push("model=" + a.model);
  } else if (span.kind === "llm") {
    if (a.model !== undefined) parts.push("model=" + a.model);
    if (a.total_tokens !== undefined) parts.push(a.total_tokens + " tok");
    if (a.cost_usd !== undefined) parts.push(formatCost(a.cost_usd));
  } else if (span.kind === "tool") {
    if (a.tool_name !== undefined) parts.push(a.tool_name);
  } else if (span.kind === "guardrail") {
    if (a.guardrail_name !== undefined) parts.push(a.guardrail_name);
    if (a.guardrail_action !== undefined) parts.push("→ " + a.guardrail_action);
  } else if (span.kind === "checkpoint") {
    if (a.session_id !== undefined) parts.push("session=" + a.session_id.slice(0, 8));
  }
  if (span.error?.message) {
    parts.push(chalk.red("error: " + span.error.message));
  }
  return parts.join(" · ");
}

/**
 * Render every span belonging to one trace as an indented tree, with a
 * summary footer (token total, cost, wall time of the root span).
 *
 * The caller is expected to have already filtered `spans` to a single
 * trace — usually the response of `GET /traces/:id`. Spans whose parent
 * is missing from the input become additional roots so partial fragments
 * left over from ring-buffer eviction still render.
 */
export function renderTraceShow(spans: readonly TuttiSpan[]): string {
  if (spans.length === 0) {
    return chalk.dim("No spans found for this trace.");
  }

  const childrenByParent = new Map<string, TuttiSpan[]>();
  const presentSpanIds = new Set(spans.map((s) => s.span_id));
  const roots: TuttiSpan[] = [];

  for (const span of spans) {
    const parent = span.parent_span_id;
    if (parent === undefined || !presentSpanIds.has(parent)) {
      roots.push(span);
      continue;
    }
    const arr = childrenByParent.get(parent) ?? [];
    arr.push(span);
    childrenByParent.set(parent, arr);
  }

  // Stable child ordering: insertion order from the tracer is the natural
  // execution order, so use that. The .sort() call below for roots is
  // for the rare multi-root edge case (eviction).
  roots.sort((a, b) => a.started_at.getTime() - b.started_at.getTime());

  const lines: string[] = [""];

  function walk(span: TuttiSpan, indent: number): void {
    lines.push(renderSpanLine(span, indent));
    const kids = childrenByParent.get(span.span_id);
    if (!kids) return;
    for (const child of kids) {
      walk(child, indent + 1);
    }
  }

  for (const root of roots) walk(root, 0);

  // Footer: aggregate from llm.completion spans + root span wall time.
  let total_tokens = 0;
  let total_cost = 0;
  let any_cost = false;
  for (const s of spans) {
    if (s.name !== "llm.completion") continue;
    total_tokens += s.attributes.total_tokens ?? 0;
    if (s.attributes.cost_usd !== undefined) {
      total_cost += s.attributes.cost_usd;
      any_cost = true;
    }
  }
  // Wall time = duration of the earliest top-level root that has one.
  const wall_ms = roots
    .map((r) => r.duration_ms)
    .find((d): d is number => d !== undefined);

  lines.push("");
  lines.push(chalk.dim("─".repeat(60)));
  lines.push(
    chalk.dim("Total: ") +
      chalk.bold(formatTokens(total_tokens)) +
      chalk.dim(" tokens · ") +
      chalk.bold(any_cost ? formatCost(total_cost) : chalk.dim("—")) +
      chalk.dim(" cost · ") +
      chalk.bold(wall_ms !== undefined ? wall_ms + "ms" : chalk.dim("—")) +
      chalk.dim(" wall"),
  );
  lines.push("");
  return lines.join("\n");
}
