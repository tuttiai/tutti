import { trace, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("tutti", "1.0.0");

export const TuttiTracer = {
  agentRun<T>(agentName: string, sessionId: string, fn: () => Promise<T>): Promise<T> {
    return tracer.startActiveSpan("agent.run", async (span) => {
      span.setAttribute("agent.name", agentName);
      span.setAttribute("session.id", sessionId);
      try {
        const result = await fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    });
  },

  llmCall<T>(model: string, fn: () => Promise<T>): Promise<T> {
    return tracer.startActiveSpan("llm.call", async (span) => {
      span.setAttribute("llm.model", model);
      try {
        const result = await fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    });
  },

  toolCall<T>(toolName: string, fn: () => Promise<T>): Promise<T> {
    return tracer.startActiveSpan("tool.call", async (span) => {
      span.setAttribute("tool.name", toolName);
      try {
        const result = await fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    });
  },
};
