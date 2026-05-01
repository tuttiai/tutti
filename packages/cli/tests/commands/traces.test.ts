/**
 * Tests for `tutti-ai traces list` and `tutti-ai traces show` rendering.
 *
 * Uses a real `TuttiTracer` from `@tuttiai/telemetry` populated with
 * fixtures, then drives `buildTraceSummaries` + the CLI render functions.
 * No real spans are emitted — every fixture is constructed in the test.
 */

import { describe, it, expect, beforeEach } from "vitest";
import chalk from "chalk";
import {
  TuttiTracer,
  buildTraceSummaries,
  type TuttiSpan,
} from "@tuttiai/telemetry";

// Vitest runs without a TTY, so chalk would otherwise emit plain text
// and the colour assertions below would never fire. Pin to level 1
// (basic 16-colour ANSI) for deterministic output.
chalk.level = 1;

import {
  isRouterSpan,
  renderRouterSummary,
  renderSpanLine,
  renderTraceShow,
  renderTracesList,
} from "../../src/commands/traces-render.js";

/**
 * Strip ANSI colour codes so we can assert against plain text without
 * worrying about chalk's exact escape sequences.
 */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * Build a representative trace: one agent.run root, one llm.completion
 * child with cost data, and one tool.call child. Returns the live tracer
 * so callers can inspect or extend it.
 */
function buildAgentTrace(tracer: TuttiTracer, options: {
  agentId?: string;
  model?: string;
  totalTokens?: number;
  costUsd?: number;
  startedAt?: Date;
} = {}): { traceId: string } {
  const root = tracer.startSpan(
    "agent.run",
    "agent",
    {
      ...(options.agentId !== undefined ? { agent_id: options.agentId } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      session_id: "sess-abc",
    },
  );
  if (options.startedAt) {
    // Override started_at for deterministic sort order in list tests.
    (root as TuttiSpan).started_at = options.startedAt;
  }

  const llm = tracer.startSpan(
    "llm.completion",
    "llm",
    { model: options.model ?? "gpt-4o" },
    root.span_id,
  );
  tracer.endSpan(llm.span_id, "ok", {
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: options.totalTokens ?? 150,
    ...(options.costUsd !== undefined ? { cost_usd: options.costUsd } : {}),
  });

  const tool = tracer.startSpan(
    "tool.call",
    "tool",
    { tool_name: "read_file", tool_input: { path: "x.md" } },
    root.span_id,
  );
  tracer.endSpan(tool.span_id, "ok", { tool_output: "file contents" });

  tracer.endSpan(root.span_id, "ok");
  return { traceId: root.trace_id };
}

describe("renderTracesList", () => {
  let tracer: TuttiTracer;

  beforeEach(() => {
    tracer = new TuttiTracer();
  });

  it("renders an empty-state line when no traces exist", () => {
    const out = renderTracesList([]);
    expect(stripAnsi(out)).toBe("No traces found.");
  });

  it("renders the column header and one row per trace", () => {
    buildAgentTrace(tracer, { agentId: "researcher", costUsd: 0.001 });

    const summaries = buildTraceSummaries(tracer.getAllSpans());
    const out = stripAnsi(renderTracesList(summaries));

    expect(out).toContain("TRACE");
    expect(out).toContain("AGENT");
    expect(out).toContain("STARTED");
    expect(out).toContain("DURATION");
    expect(out).toContain("STATUS");
    expect(out).toContain("TOKENS");
    expect(out).toContain("COST");
    expect(out).toContain("researcher");
    expect(out).toContain("ok");
    expect(out).toContain("150");
    expect(out).toContain("$0.001000");
    // Trace id is rendered as the first 8 chars only.
    expect(out).toContain(summaries[0]!.trace_id.slice(0, 8));
  });

  it("orders traces most-recent-first and limits to 20", () => {
    // Insert 25 root spans with monotonically increasing started_at so
    // the sort step in buildTraceSummaries has unambiguous input.
    for (let i = 0; i < 25; i++) {
      const minute = String(i).padStart(2, "0");
      buildAgentTrace(tracer, {
        agentId: "a" + i,
        startedAt: new Date(`2026-04-15T10:${minute}:00.000Z`),
      });
    }

    const summaries = buildTraceSummaries(tracer.getAllSpans());
    expect(summaries).toHaveLength(20);
    expect(summaries[0]!.agent_id).toBe("a24"); // most recent
    expect(summaries[19]!.agent_id).toBe("a5"); // 20th most recent
  });

  it("colours status — green for ok, red for error, yellow for running", () => {
    buildAgentTrace(tracer, { agentId: "ok-agent" });

    const errRoot = tracer.startSpan("agent.run", "agent", { agent_id: "err-agent" });
    tracer.endSpan(errRoot.span_id, "error", undefined, { message: "boom" });

    tracer.startSpan("agent.run", "agent", { agent_id: "running-agent" });

    const summaries = buildTraceSummaries(tracer.getAllSpans());
    const raw = renderTracesList(summaries);

    // chalk green = \u001b[32m, red = \u001b[31m, yellow = \u001b[33m
    expect(raw).toContain("\u001b[32mok\u001b[39m");
    expect(raw).toContain("\u001b[31merror\u001b[39m");
    expect(raw).toContain("\u001b[33mrunning\u001b[39m");
  });

  it("renders em-dashes for unknown / missing fields (cost, agent, tokens)", () => {
    // Trace where the model is unregistered → no cost, but tokens present.
    const root = tracer.startSpan("agent.run", "agent");
    const llm = tracer.startSpan(
      "llm.completion",
      "llm",
      { model: "no-price-model" },
      root.span_id,
    );
    tracer.endSpan(llm.span_id, "ok", {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
    tracer.endSpan(root.span_id, "ok");

    const summaries = buildTraceSummaries(tracer.getAllSpans());
    const out = stripAnsi(renderTracesList(summaries));
    expect(out).toContain("—"); // em-dash for missing agent / cost
    expect(out).toContain("15"); // tokens still present
  });
});

describe("renderTraceShow", () => {
  let tracer: TuttiTracer;

  beforeEach(() => {
    tracer = new TuttiTracer();
  });

  it("returns an empty-state line when given no spans", () => {
    expect(stripAnsi(renderTraceShow([]))).toBe("No spans found for this trace.");
  });

  it("renders the root span, then children indented under it", () => {
    const { traceId } = buildAgentTrace(tracer, {
      agentId: "researcher",
      model: "gpt-4o",
      costUsd: 0.0125,
    });
    const spans = tracer.getTrace(traceId);

    const out = stripAnsi(renderTraceShow(spans));
    const lines = out.split("\n").filter((l) => l.trim() !== "");

    // First non-empty line is the root span.
    expect(lines[0]).toMatch(/^▶ agent\.run /);
    // llm.completion and tool.call are nested one level under root.
    const llmLine = lines.find((l) => l.includes("llm.completion"));
    const toolLine = lines.find((l) => l.includes("tool.call"));
    expect(llmLine).toBeDefined();
    expect(toolLine).toBeDefined();
    expect(llmLine!.startsWith("  ")).toBe(true); // indent = 2 spaces
    expect(toolLine!.startsWith("  ")).toBe(true);
    // Footer summary is present.
    expect(out).toMatch(/Total: 150 tokens/);
    expect(out).toMatch(/\$0\.012500/);
  });

  it("indents children of children correctly (transitive nesting)", () => {
    const root = tracer.startSpan("agent.run", "agent", { agent_id: "x" });
    const mid = tracer.startSpan("guardrail", "guardrail", { guardrail_name: "beforeRun" }, root.span_id);
    const leaf = tracer.startSpan("llm.completion", "llm", { model: "gpt-4o" }, mid.span_id);
    tracer.endSpan(leaf.span_id, "ok", {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      cost_usd: 0.0001,
    });
    tracer.endSpan(mid.span_id, "ok", { guardrail_action: "pass" });
    tracer.endSpan(root.span_id, "ok");

    const out = stripAnsi(renderTraceShow(tracer.getTrace(root.trace_id)));
    const lines = out.split("\n");

    const rootLine = lines.find((l) => l.startsWith("▶ agent.run"));
    const guardrailLine = lines.find((l) => l.includes("guardrail"));
    const llmLine = lines.find((l) => l.includes("llm.completion"));

    expect(rootLine).toBeDefined();
    expect(guardrailLine!.startsWith("  ")).toBe(true);
    expect(guardrailLine!.startsWith("    ")).toBe(false);
    expect(llmLine!.startsWith("    ")).toBe(true); // two levels deep
  });

  it("includes a summary footer with totals and wall time", () => {
    const { traceId } = buildAgentTrace(tracer, { costUsd: 0.005 });
    const out = stripAnsi(renderTraceShow(tracer.getTrace(traceId)));
    expect(out).toMatch(/Total: 150 tokens/);
    expect(out).toMatch(/\$0\.005000/);
    expect(out).toMatch(/\d+ms wall/);
  });

  it("colours an errored span red and surfaces its error message", () => {
    const root = tracer.startSpan("agent.run", "agent", { agent_id: "x" });
    const tool = tracer.startSpan("tool.call", "tool", { tool_name: "fail" }, root.span_id);
    tracer.endSpan(tool.span_id, "error", undefined, {
      message: "kaboom",
      stack: "at Foo.bar",
    });
    tracer.endSpan(root.span_id, "ok");

    const raw = renderTraceShow(tracer.getTrace(root.trace_id));
    expect(raw).toContain("\u001b[31merror\u001b[39m"); // red status badge
    expect(stripAnsi(raw)).toContain("kaboom");
  });

  it("renders a still-running span as yellow with (running) duration", () => {
    const root = tracer.startSpan("agent.run", "agent", { agent_id: "x" });
    // Don't end root — it's running.
    const raw = renderTraceShow(tracer.getTrace(root.trace_id));
    expect(raw).toContain("\u001b[33mrunning\u001b[39m");
    expect(stripAnsi(raw)).toContain("(running)");
  });
});

describe("renderSpanLine", () => {
  it("uses the right icon per span kind", () => {
    const tracer = new TuttiTracer();
    const cases: Array<{ name: string; kind: Parameters<TuttiTracer["startSpan"]>[1]; icon: string }> = [
      { name: "agent.run", kind: "agent", icon: "▶" },
      { name: "llm.completion", kind: "llm", icon: "◆" },
      { name: "tool.call", kind: "tool", icon: "⚙" },
      { name: "guardrail", kind: "guardrail", icon: "🛡" },
      { name: "checkpoint", kind: "checkpoint", icon: "💾" },
    ];

    for (const c of cases) {
      const span = tracer.startSpan(c.name, c.kind);
      tracer.endSpan(span.span_id, "ok");
      const out = stripAnsi(renderSpanLine(span, 0));
      expect(out.startsWith(c.icon + " " + c.name + " ")).toBe(true);
    }
  });

  it("respects indent level (2 spaces per level)", () => {
    const tracer = new TuttiTracer();
    const span = tracer.startSpan("agent.run", "agent");
    tracer.endSpan(span.span_id, "ok");
    expect(stripAnsi(renderSpanLine(span, 0)).startsWith("▶")).toBe(true);
    expect(stripAnsi(renderSpanLine(span, 1)).startsWith("  ▶")).toBe(true);
    expect(stripAnsi(renderSpanLine(span, 3)).startsWith("      ▶")).toBe(true);
  });
});

/**
 * Build an agent.run trace whose llm.completion children carry the
 * `router_*` attributes set by `AgentRunner`'s `@tuttiai/router`
 * event hooks. `decisions` is the per-call sequence; pass `fallback`
 * to record a fallback on a specific call.
 */
function buildRouterTrace(
  tracer: TuttiTracer,
  options: {
    agentId?: string;
    decisions: Array<{
      tier: string;
      classifier: string;
      model: string;
      reason: string;
      cost?: number;
      fallback_from?: string;
      fallback_to?: string;
      fallback_error?: string;
    }>;
  },
): { traceId: string } {
  const root = tracer.startSpan(
    "agent.run",
    "agent",
    {
      ...(options.agentId !== undefined ? { agent_id: options.agentId } : {}),
      session_id: "sess-r",
    },
  );

  for (const d of options.decisions) {
    const llm = tracer.startSpan("llm.completion", "llm", { model: d.model }, root.span_id);
    tracer.setAttributes(llm.span_id, {
      router_tier: d.tier,
      router_model: d.model,
      router_classifier: d.classifier,
      router_reason: d.reason,
      ...(d.cost !== undefined ? { router_cost_estimate: d.cost } : {}),
      ...(d.fallback_from !== undefined ? { router_fallback_from: d.fallback_from } : {}),
      ...(d.fallback_to !== undefined ? { router_fallback_to: d.fallback_to } : {}),
      ...(d.fallback_error !== undefined ? { router_fallback_error: d.fallback_error } : {}),
    });
    tracer.endSpan(llm.span_id, "ok");
  }
  tracer.endSpan(root.span_id, "ok");
  return { traceId: root.trace_id };
}

describe("isRouterSpan", () => {
  it("returns true for an llm.completion span carrying any router_* attribute", () => {
    const tracer = new TuttiTracer();
    const span = tracer.startSpan("llm.completion", "llm");
    tracer.setAttributes(span.span_id, { router_tier: "small" });
    tracer.endSpan(span.span_id, "ok");
    expect(isRouterSpan(span)).toBe(true);
  });

  it("returns false for spans with no router_* attributes", () => {
    const tracer = new TuttiTracer();
    const span = tracer.startSpan("llm.completion", "llm", { model: "m" });
    tracer.endSpan(span.span_id, "ok", { total_tokens: 10 });
    expect(isRouterSpan(span)).toBe(false);
  });

  it("returns true even if only fallback fields are set", () => {
    const tracer = new TuttiTracer();
    const span = tracer.startSpan("llm.completion", "llm");
    tracer.setAttributes(span.span_id, {
      router_fallback_from: "a",
      router_fallback_to: "b",
      router_fallback_error: "boom",
    });
    tracer.endSpan(span.span_id, "ok");
    expect(isRouterSpan(span)).toBe(true);
  });
});

describe("renderRouterSummary", () => {
  let tracer: TuttiTracer;
  beforeEach(() => {
    tracer = new TuttiTracer();
  });

  it("renders the empty-state message when the trace has no router decisions", () => {
    const root = tracer.startSpan("agent.run", "agent", { agent_id: "plain" });
    const llm = tracer.startSpan("llm.completion", "llm", { model: "m" }, root.span_id);
    tracer.endSpan(llm.span_id, "ok");
    tracer.endSpan(root.span_id, "ok");
    const out = stripAnsi(renderRouterSummary(tracer.getAllSpans()));
    expect(out).toBe("No router decisions found in this trace.");
  });

  it("renders one row per router decision with tier, classifier, model, cost, reason", () => {
    const { traceId } = buildRouterTrace(tracer, {
      agentId: "assistant",
      decisions: [
        { tier: "small", classifier: "heuristic", model: "small-m", reason: "classified", cost: 0.000123 },
        { tier: "medium", classifier: "heuristic", model: "medium-m", reason: "classified", cost: 0.000456 },
      ],
    });

    const out = stripAnsi(renderRouterSummary(tracer.getTrace(traceId)));
    expect(out).toContain("Trace " + traceId.slice(0, 8));
    expect(out).toContain("agent: assistant");
    expect(out).toContain("TIER");
    expect(out).toContain("CLASSIFIER");
    expect(out).toContain("MODEL");
    expect(out).toContain("COST");
    expect(out).toContain("REASON");
    expect(out).toContain("small");
    expect(out).toContain("medium");
    expect(out).toContain("small-m");
    expect(out).toContain("medium-m");
    expect(out).toContain("$0.000123");
    expect(out).toContain("$0.000456");
    expect(out).toContain("classified");
    expect(out).toContain("2 router decisions");
    // Footer total = 0.000123 + 0.000456 = 0.000579
    expect(out).toContain("$0.000579");
  });

  it("annotates fallback decisions with a from→to arrow and the error message", () => {
    const { traceId } = buildRouterTrace(tracer, {
      agentId: "assistant",
      decisions: [
        {
          tier: "fallback",
          classifier: "heuristic",
          model: "fallback-m",
          reason: "fallback after error: boom",
          cost: 0.0007,
          fallback_from: "small-m",
          fallback_to: "fallback-m",
          fallback_error: "boom",
        },
      ],
    });

    const out = stripAnsi(renderRouterSummary(tracer.getTrace(traceId)));
    expect(out).toContain("fallback");
    expect(out).toContain("fallback-m");
    expect(out).toContain("fallback after error: boom");
    expect(out).toContain("↩ small-m → fallback-m");
    expect(out).toContain('"boom"');
    expect(out).toContain("1 router decision");
    // Singular form, not "1 router decisions".
    expect(out).not.toContain("1 router decisions");
  });
});
