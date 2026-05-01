import { AsyncLocalStorage } from "node:async_hooks";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import {
  estimateCost,
  getTuttiTracer,
  type GuardrailAction,
  type SpanKind,
  type TuttiSpanAttributes,
} from "@tuttiai/telemetry";
import type { ChatResponse, ToolResultBlock } from "@tuttiai/types";

const otel = trace.getTracer("tutti", "1.0.0");
const tracer = getTuttiTracer();
const spanCtx = new AsyncLocalStorage<{ spanId: string; traceId: string }>();

// Re-export so consumers can import directly from @tuttiai/core.
export { getTuttiTracer } from "@tuttiai/telemetry";

/**
 * Trace id of the currently executing async context, or `undefined` when
 * called outside any traced span.
 */
export function getCurrentTraceId(): string | undefined {
  return spanCtx.getStore()?.traceId;
}

/**
 * Span id of the immediately enclosing span — useful when callers want to
 * record a span manually under the current parent.
 */
export function getCurrentSpanId(): string | undefined {
  return spanCtx.getStore()?.spanId;
}

interface SpanOptions {
  name: string;
  kind: SpanKind;
  attributes?: TuttiSpanAttributes;
  /** Emit a parallel OpenTelemetry span with this name and attribute set. */
  otel?: { name: string; attributes?: Record<string, string | number> };
}

/**
 * Open a span on both the in-process tracer and (optionally) OpenTelemetry,
 * run `fn` inside the span's async context so children find their parent,
 * then close both spans with the appropriate status.
 *
 * `endAttrs` is invoked with `fn`'s resolved value to derive attributes
 * known only at completion (token counts, tool output, etc.).
 *
 * `errorAttrs` is invoked when `fn` throws to derive attributes that
 * should be set on the failed span (e.g. `guardrail_action: 'block'`).
 */
async function recordSpan<T>(
  options: SpanOptions,
  fn: () => Promise<T>,
  endAttrs?: (result: T) => Partial<TuttiSpanAttributes> | undefined,
  errorAttrs?: () => Partial<TuttiSpanAttributes> | undefined,
): Promise<T> {
  const parent = spanCtx.getStore()?.spanId;
  const span = tracer.startSpan(options.name, options.kind, options.attributes ?? {}, parent);

  const otelOpts = options.otel;
  const runWithOtel = async (): Promise<T> => {
    if (!otelOpts) return fn();
    return otel.startActiveSpan(otelOpts.name, async (otelSpan) => {
      if (otelOpts.attributes) {
        for (const [k, v] of Object.entries(otelOpts.attributes)) {
          otelSpan.setAttribute(k, v);
        }
      }
      try {
        const result = await fn();
        otelSpan.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        otelSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        otelSpan.end();
      }
    });
  };

  try {
    const result = await spanCtx.run(
      { spanId: span.span_id, traceId: span.trace_id },
      runWithOtel,
    );
    tracer.endSpan(span.span_id, "ok", endAttrs?.(result));
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    tracer.endSpan(
      span.span_id,
      "error",
      errorAttrs?.(),
      err instanceof Error
        ? { message, ...(err.stack ? { stack: err.stack } : {}) }
        : { message },
    );
    throw err;
  }
}

/**
 * Map from `TuttiSpanAttributes` router-keys to their dotted OTel
 * counterparts. Centralised so the in-process and OTel attribute names
 * stay in sync — change one, change the other.
 */
const ROUTER_OTEL_KEYS: Record<string, string> = {
  router_tier: "tutti.router.tier",
  router_model: "tutti.router.model",
  router_classifier: "tutti.router.classifier",
  router_reason: "tutti.router.reason",
  router_cost_estimate: "tutti.router.cost_estimate",
  router_fallback_from: "tutti.router.fallback.from_model",
  router_fallback_to: "tutti.router.fallback.to_model",
  router_fallback_error: "tutti.router.fallback.error",
};

/**
 * Merge cross-cutting attributes onto the currently active LLM span on
 * BOTH the in-process tracer and the parallel OTel span.
 *
 * Designed for callers that know an attribute mid-flight — notably
 * `AgentRunner`'s `@tuttiai/router` decision/fallback handlers, which
 * fire inside `provider.chat()` after `llm.completion` has opened but
 * before it closes. No-op when called outside any traced span.
 *
 * @param attrs - Subset of {@link TuttiSpanAttributes}. Router fields
 *   are mirrored to `tutti.router.*` OTel attribute keys via
 *   {@link ROUTER_OTEL_KEYS}; other fields are merged as-is on the
 *   in-process span only.
 */
export function setActiveLlmAttributes(attrs: Partial<TuttiSpanAttributes>): void {
  const span_id = spanCtx.getStore()?.spanId;
  if (span_id) tracer.setAttributes(span_id, attrs);

  const otelSpan = trace.getActiveSpan();
  if (!otelSpan) return;
  const otelAttrs: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    const otelKey = ROUTER_OTEL_KEYS[k];
    if (!otelKey) continue;
    if (typeof v === "string" || typeof v === "number") otelAttrs[otelKey] = v;
  }
  if (Object.keys(otelAttrs).length > 0) otelSpan.setAttributes(otelAttrs);
}

/**
 * Tracing helpers used by the agent runner. Each helper opens an in-process
 * span (visible via `getTuttiTracer()`) plus, for the foundational kinds, a
 * parallel OpenTelemetry span so existing OTel pipelines keep working.
 */
export const Tracing = {
  /**
   * Open the root `agent.run` span. Establishes a fresh trace id that
   * every nested `llm.completion`, `tool.call`, `guardrail`, and
   * `checkpoint` span will inherit.
   */
  agentRun<T>(
    agentName: string,
    sessionId: string,
    model: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const attributes: TuttiSpanAttributes = {
      agent_id: agentName,
      session_id: sessionId,
    };
    if (model) attributes.model = model;
    return recordSpan(
      {
        name: "agent.run",
        kind: "agent",
        attributes,
        otel: {
          name: "agent.run",
          attributes: {
            "agent.name": agentName,
            "session.id": sessionId,
            ...(model ? { "llm.model": model } : {}),
          },
        },
      },
      fn,
    );
  },

  /**
   * Open an `llm.completion` span around a single provider call. Token
   * counts derived from the response are recorded on close.
   */
  llmCall(
    model: string,
    fn: () => Promise<ChatResponse>,
  ): Promise<ChatResponse> {
    return recordSpan(
      {
        name: "llm.completion",
        kind: "llm",
        attributes: { model },
        otel: { name: "llm.call", attributes: { "llm.model": model } },
      },
      fn,
      (response) => {
        const prompt_tokens = response.usage.input_tokens;
        const completion_tokens = response.usage.output_tokens;
        const cost = estimateCost(model, prompt_tokens, completion_tokens);
        return {
          prompt_tokens,
          completion_tokens,
          total_tokens: prompt_tokens + completion_tokens,
          ...(cost !== null ? { cost_usd: cost } : {}),
        };
      },
    );
  },

  /**
   * Open a `tool.call` span around a single tool invocation. The tool
   * input is recorded on open; the (possibly truncated) output content
   * is recorded on close.
   */
  toolCall(
    toolName: string,
    input: unknown,
    fn: () => Promise<ToolResultBlock>,
  ): Promise<ToolResultBlock> {
    return recordSpan(
      {
        name: "tool.call",
        kind: "tool",
        attributes: { tool_name: toolName, tool_input: input },
        otel: { name: "tool.call", attributes: { "tool.name": toolName } },
      },
      fn,
      (result) => ({ tool_output: result.content }),
    );
  },

  /**
   * Open a `guardrail` span around a guardrail hook. `resolveAction`
   * inspects the hook's return value to decide whether the action was
   * a `pass` or a `redact`. A thrown error is recorded as `block`.
   */
  guardrail<T>(
    guardrailName: string,
    fn: () => Promise<T>,
    resolveAction: (result: T) => GuardrailAction = () => "pass",
  ): Promise<T> {
    return recordSpan(
      {
        name: "guardrail",
        kind: "guardrail",
        attributes: { guardrail_name: guardrailName },
      },
      fn,
      (result) => ({ guardrail_action: resolveAction(result) }),
      () => ({ guardrail_action: "block" }),
    );
  },

  /**
   * Open a `checkpoint` span around a durable checkpoint write. The
   * inner fn is expected to call `CheckpointStore.save(...)`.
   */
  checkpoint<T>(
    sessionId: string,
    turn: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    return recordSpan(
      {
        name: "checkpoint",
        kind: "checkpoint",
        attributes: { session_id: sessionId },
        otel: {
          name: "checkpoint",
          attributes: { "session.id": sessionId, turn },
        },
      },
      fn,
    );
  },
};
