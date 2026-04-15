import { AsyncLocalStorage } from "node:async_hooks";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import {
  TuttiTracer,
  type GuardrailAction,
  type SpanKind,
  type TuttiSpanAttributes,
} from "@tuttiai/telemetry";
import type { ChatResponse, ToolResultBlock } from "@tuttiai/types";

const otel = trace.getTracer("tutti", "1.0.0");
const tracer = new TuttiTracer();
const spanCtx = new AsyncLocalStorage<{ spanId: string; traceId: string }>();

/**
 * Return the in-process span tracer singleton. Same instance is shared
 * across every agent run in this process, so external observers (Studio,
 * exporters, log sinks) can subscribe once and receive everything.
 */
export function getTuttiTracer(): TuttiTracer {
  return tracer;
}

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
      (response) => ({
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      }),
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
