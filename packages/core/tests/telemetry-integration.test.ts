import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type { TuttiSpan } from "@tuttiai/telemetry";
import { getRunCost, registerModelPrice } from "@tuttiai/telemetry";

import { AgentRunner } from "../src/agent-runner.js";
import { EventBus } from "../src/event-bus.js";
import { InMemorySessionStore } from "../src/session-store.js";
import { getTuttiTracer } from "../src/telemetry.js";
import {
  createMockProvider,
  textResponse,
  toolUseResponse,
  simpleAgent,
} from "./helpers/mock-provider.js";
import type { Voice } from "@tuttiai/types";

/**
 * Subscribe to the global tracer for the duration of one run, returning the
 * spans that were *closed* during that run plus an unsubscribe handle.
 *
 * We capture closed spans (status !== 'running') so token counts and
 * tool outputs — only known on close — are populated by the time tests
 * inspect them.
 */
function captureClosedSpans(): { spans: TuttiSpan[]; stop: () => void } {
  const spans: TuttiSpan[] = [];
  const stop = getTuttiTracer().subscribe((span) => {
    if (span.status !== "running") spans.push(span);
  });
  return { spans, stop };
}

describe("AgentRunner telemetry integration", () => {
  it("emits a single agent.run span tagged with agent_id, session_id, model", async () => {
    const provider = createMockProvider([textResponse("Hello!")]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());

    const { spans, stop } = captureClosedSpans();
    try {
      const result = await runner.run({ ...simpleAgent, model: "test-model" }, "Hi");

      const agentSpans = spans.filter((s) => s.name === "agent.run");
      expect(agentSpans).toHaveLength(1);
      const agentSpan = agentSpans[0]!;
      expect(agentSpan.kind).toBe("agent");
      expect(agentSpan.status).toBe("ok");
      expect(agentSpan.attributes.agent_id).toBe("test-agent");
      expect(agentSpan.attributes.session_id).toBe(result.session_id);
      expect(agentSpan.attributes.model).toBe("test-model");
      expect(agentSpan.parent_span_id).toBeUndefined();
      expect(agentSpan.duration_ms).toBeGreaterThanOrEqual(0);
    } finally {
      stop();
    }
  });

  it("returns the trace_id on the AgentResult", async () => {
    const provider = createMockProvider([textResponse("Hello!")]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());

    const { spans, stop } = captureClosedSpans();
    try {
      const result = await runner.run(simpleAgent, "Hi");
      expect(result.trace_id).toMatch(/^[0-9a-f-]{36}$/);

      // The trace_id on the result must match the agent.run span.
      const agentSpan = spans.find((s) => s.name === "agent.run");
      expect(agentSpan?.trace_id).toBe(result.trace_id);
    } finally {
      stop();
    }
  });

  it("emits an llm.completion span per LLM call with token counts populated", async () => {
    const provider = createMockProvider([textResponse("hi")]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());

    const { spans, stop } = captureClosedSpans();
    try {
      await runner.run({ ...simpleAgent, model: "test-model" }, "Hi");

      const llmSpans = spans.filter((s) => s.name === "llm.completion");
      expect(llmSpans).toHaveLength(1);
      const llmSpan = llmSpans[0]!;
      expect(llmSpan.kind).toBe("llm");
      expect(llmSpan.status).toBe("ok");
      expect(llmSpan.attributes.model).toBe("test-model");
      expect(llmSpan.attributes.prompt_tokens).toBe(10);
      expect(llmSpan.attributes.completion_tokens).toBe(5);
      expect(llmSpan.attributes.total_tokens).toBe(15);
    } finally {
      stop();
    }
  });

  it("emits a tool.call span per tool invocation with input and output captured", async () => {
    const voice: Voice = {
      name: "math",
      required_permissions: [],
      tools: [
        {
          name: "double",
          description: "Doubles a number",
          parameters: z.object({ x: z.number() }),
          execute: async (input: { x: number }) => ({
            content: `Result: ${input.x * 2}`,
          }),
        },
      ],
    };

    const provider = createMockProvider([
      toolUseResponse("double", { x: 21 }),
      textResponse("done"),
    ]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());

    const { spans, stop } = captureClosedSpans();
    try {
      await runner.run({ ...simpleAgent, voices: [voice] }, "double 21");

      const toolSpans = spans.filter((s) => s.name === "tool.call");
      expect(toolSpans).toHaveLength(1);
      const toolSpan = toolSpans[0]!;
      expect(toolSpan.kind).toBe("tool");
      expect(toolSpan.status).toBe("ok");
      expect(toolSpan.attributes.tool_name).toBe("double");
      expect(toolSpan.attributes.tool_input).toEqual({ x: 21 });
      // tool_output captures the PromptGuard-wrapped content that the LLM
      // actually receives, not the raw return from execute().
      expect(toolSpan.attributes.tool_output).toContain("Result: 42");
    } finally {
      stop();
    }
  });

  it("nests llm.completion and tool.call spans under the agent.run span (same trace_id, correct parent)", async () => {
    const voice: Voice = {
      name: "math",
      required_permissions: [],
      tools: [
        {
          name: "noop",
          description: "no-op",
          parameters: z.object({}),
          execute: async () => ({ content: "ok" }),
        },
      ],
    };

    const provider = createMockProvider([
      toolUseResponse("noop", {}),
      textResponse("done"),
    ]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());

    const { spans, stop } = captureClosedSpans();
    try {
      const result = await runner.run({ ...simpleAgent, voices: [voice] }, "go");

      // Every span shares the agent run's trace_id.
      const traceIds = new Set(spans.map((s) => s.trace_id));
      expect(traceIds.size).toBe(1);
      expect(traceIds.has(result.trace_id!)).toBe(true);

      const agentSpan = spans.find((s) => s.name === "agent.run");
      expect(agentSpan).toBeDefined();

      // LLM and tool spans both nest under agent.run.
      const llmSpans = spans.filter((s) => s.name === "llm.completion");
      const toolSpans = spans.filter((s) => s.name === "tool.call");
      expect(llmSpans).toHaveLength(2);
      expect(toolSpans).toHaveLength(1);
      for (const child of [...llmSpans, ...toolSpans]) {
        expect(child.parent_span_id).toBe(agentSpan!.span_id);
      }
    } finally {
      stop();
    }
  });

  it("the same trace can be retrieved later via getTuttiTracer().getTrace()", async () => {
    const provider = createMockProvider([textResponse("hi")]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());

    const result = await runner.run(simpleAgent, "Hi");
    expect(result.trace_id).toBeDefined();

    const trace = getTuttiTracer().getTrace(result.trace_id!);
    expect(trace.length).toBeGreaterThanOrEqual(2);
    expect(trace.some((s) => s.name === "agent.run")).toBe(true);
    expect(trace.some((s) => s.name === "llm.completion")).toBe(true);
  });

  it("getTuttiTracer() returns the same singleton across calls", () => {
    expect(getTuttiTracer()).toBe(getTuttiTracer());
  });

  it("emits a guardrail span with action='redact' when beforeRun rewrites input", async () => {
    const provider = createMockProvider([textResponse("ok")]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());

    const { spans, stop } = captureClosedSpans();
    try {
      await runner.run(
        {
          ...simpleAgent,
          beforeRun: (input) => `[redacted] ${input}`,
        },
        "hello",
      );

      const guardrailSpans = spans.filter((s) => s.name === "guardrail");
      expect(guardrailSpans).toHaveLength(1);
      expect(guardrailSpans[0]!.attributes.guardrail_name).toBe("beforeRun");
      expect(guardrailSpans[0]!.attributes.guardrail_action).toBe("redact");
      expect(guardrailSpans[0]!.status).toBe("ok");
    } finally {
      stop();
    }
  });

  it("emits a guardrail span with action='block' when afterRun throws", async () => {
    const provider = createMockProvider([textResponse("hi")]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());

    const { spans, stop } = captureClosedSpans();
    try {
      await expect(
        runner.run(
          {
            ...simpleAgent,
            afterRun: () => {
              throw new Error("blocked by policy");
            },
          },
          "hi",
        ),
      ).rejects.toThrow("blocked by policy");

      const guardrailSpans = spans.filter((s) => s.name === "guardrail");
      expect(guardrailSpans).toHaveLength(1);
      expect(guardrailSpans[0]!.attributes.guardrail_name).toBe("afterRun");
      expect(guardrailSpans[0]!.attributes.guardrail_action).toBe("block");
      expect(guardrailSpans[0]!.status).toBe("error");
      expect(guardrailSpans[0]!.error?.message).toBe("blocked by policy");
    } finally {
      stop();
    }
  });

  it("isolates traces from concurrent runs (no parent leakage between runs)", async () => {
    const provider1 = createMockProvider([textResponse("a")]);
    const provider2 = createMockProvider([textResponse("b")]);
    const sessions = new InMemorySessionStore();
    const runner1 = new AgentRunner(provider1, new EventBus(), sessions);
    const runner2 = new AgentRunner(provider2, new EventBus(), sessions);

    const [r1, r2] = await Promise.all([
      runner1.run(simpleAgent, "one"),
      runner2.run(simpleAgent, "two"),
    ]);

    expect(r1.trace_id).toBeDefined();
    expect(r2.trace_id).toBeDefined();
    expect(r1.trace_id).not.toBe(r2.trace_id);

    // Each trace stays self-contained.
    const trace1 = getTuttiTracer().getTrace(r1.trace_id!);
    const trace2 = getTuttiTracer().getTrace(r2.trace_id!);
    expect(trace1.every((s) => s.trace_id === r1.trace_id)).toBe(true);
    expect(trace2.every((s) => s.trace_id === r2.trace_id)).toBe(true);
  });

  it("propagates tool errors to the tool.call span without breaking the agent.run span", async () => {
    const voice: Voice = {
      name: "failing",
      required_permissions: [],
      tools: [
        {
          name: "fail",
          description: "always fails",
          parameters: z.object({}),
          execute: async () => {
            throw new Error("kaboom");
          },
        },
      ],
    };

    const provider = createMockProvider([
      toolUseResponse("fail", {}),
      textResponse("recovered"),
    ]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());

    const { spans, stop } = captureClosedSpans();
    try {
      const result = await runner.run({ ...simpleAgent, voices: [voice] }, "go");
      expect(result.output).toBe("recovered");

      // The tool error is converted to a tool_result with is_error=true,
      // so the tool span itself completes with status='ok'. Agent.run
      // still completes successfully.
      const agentSpan = spans.find((s) => s.name === "agent.run");
      const toolSpan = spans.find((s) => s.name === "tool.call");
      expect(agentSpan?.status).toBe("ok");
      expect(toolSpan).toBeDefined();
    } finally {
      stop();
    }
  });

  it("records cost_usd on llm.completion spans for known models, surfaces it on result.usage and via getRunCost", async () => {
    const provider = createMockProvider([textResponse("Hello!")]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());

    const { spans, stop } = captureClosedSpans();
    try {
      // gpt-4o: $5 / 1M input, $15 / 1M output. textResponse() returns
      // input_tokens=10, output_tokens=5 — so expected cost is
      // 10 × 5/1M + 5 × 15/1M = 0.00005 + 0.000075 = 0.000125.
      const result = await runner.run({ ...simpleAgent, model: "gpt-4o" }, "Hi");

      const llmSpan = spans.find((s) => s.name === "llm.completion");
      expect(llmSpan?.attributes.cost_usd).toBeCloseTo(0.000125, 10);

      // Per-run aggregate is attached to result.usage.cost_usd (consumers
      // get cost without importing @tuttiai/telemetry directly).
      expect(result.usage.cost_usd).toBeCloseTo(0.000125, 10);

      // getRunCost reads the same data back from the singleton tracer.
      expect(result.trace_id).toBeDefined();
      const runCost = getRunCost(result.trace_id!);
      expect(runCost.cost_usd).not.toBeNull();
      expect(runCost.cost_usd!).toBeGreaterThan(0);
      expect(runCost.cost_usd!).toBeCloseTo(0.000125, 10);
      expect(runCost.prompt_tokens).toBe(10);
      expect(runCost.completion_tokens).toBe(5);
      expect(runCost.total_tokens).toBe(15);
    } finally {
      stop();
    }
  });

  it("leaves cost_usd unset on result.usage when the model is not in the price table", async () => {
    const provider = createMockProvider([textResponse("Hello!")]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());

    const result = await runner.run(
      { ...simpleAgent, model: "totally-made-up-model" },
      "Hi",
    );

    expect(result.usage.cost_usd).toBeUndefined();
    expect(result.trace_id).toBeDefined();
    expect(getRunCost(result.trace_id!).cost_usd).toBeNull();
  });

  it("picks up custom prices registered via registerModelPrice", async () => {
    registerModelPrice("test-fine-tuned-model", 100, 200);

    const provider = createMockProvider([textResponse("Hello!")]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());

    // 10 × 100/1M + 5 × 200/1M = 0.001 + 0.001 = 0.002
    const result = await runner.run(
      { ...simpleAgent, model: "test-fine-tuned-model" },
      "Hi",
    );

    expect(result.usage.cost_usd).toBeCloseTo(0.002, 10);
  });

  it("subscriber callback exceptions never break the run", async () => {
    const provider = createMockProvider([textResponse("hi")]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());

    const noisySubscriber = vi.fn(() => {
      throw new Error("subscriber boom");
    });
    const stop = getTuttiTracer().subscribe(noisySubscriber);
    try {
      await expect(runner.run(simpleAgent, "Hi")).resolves.toMatchObject({
        output: "hi",
      });
      expect(noisySubscriber).toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});
