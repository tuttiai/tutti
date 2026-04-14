import type { FastifyInstance, FastifyError, FastifyRequest, FastifyReply } from "fastify";

import {
  TuttiError,
  AuthenticationError,
  AgentNotFoundError,
  ToolTimeoutError,
  BudgetExceededError,
  RateLimitError,
  PermissionError,
  ContextWindowError,
  PathTraversalError,
  UrlValidationError,
  createLogger,
} from "@tuttiai/core";

const logger = createLogger("tutti-server");

/**
 * Map a {@link TuttiError} subclass to the appropriate HTTP status code.
 *
 * Errors not recognised as Tutti types fall through to `undefined` so the
 * caller can default to 500.
 */
function httpStatusForError(err: TuttiError): number {
  if (err instanceof AuthenticationError) return 401;
  if (err instanceof PermissionError) return 403;
  if (err instanceof AgentNotFoundError) return 404;
  if (err instanceof ToolTimeoutError) return 504;
  if (err instanceof BudgetExceededError) return 402;
  if (err instanceof RateLimitError) return 429;
  if (err instanceof ContextWindowError) return 413;
  if (err instanceof PathTraversalError) return 400;
  if (err instanceof UrlValidationError) return 400;
  return 500;
}

/** Whether we should hide implementation details from the response. */
function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Build a JSON error body, redacting the stack trace in production.
 */
function buildErrorBody(
  err: Error,
  status: number,
  requestId: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    error: err instanceof TuttiError ? err.code : "INTERNAL_ERROR",
    message: status >= 500 && isProduction()
      ? "Internal server error"
      : err.message,
    request_id: requestId,
  };

  if (!isProduction() && err.stack) {
    body.stack = err.stack;
  }

  if (err instanceof TuttiError && Object.keys(err.context).length > 0) {
    body.context = err.context;
  }

  return body;
}

/**
 * Register a global error handler on the Fastify instance.
 *
 * - Maps recognised {@link TuttiError} subtypes to HTTP status codes.
 * - Logs all 5xx errors at `error` level with the request ID.
 * - Never exposes stack traces when `NODE_ENV=production`.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    async (err: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) => {
      const requestId = String(request.id ?? "unknown");

      // Fastify validation errors (schema failures) carry a `validation` prop.
      if ("validation" in err) {
        return reply.code(400).send({
          error: "VALIDATION_ERROR",
          message: err.message,
          request_id: requestId,
        });
      }

      // @fastify/rate-limit throws with statusCode 429 and sets the
      // Retry-After header on the reply. Reformat the body to match our
      // API contract: { error, retry_after_ms, request_id }.
      if ((err as FastifyError).statusCode === 429) {
        const retryAfter = reply.getHeader("retry-after");
        const retrySeconds = typeof retryAfter === "number"
          ? retryAfter
          : typeof retryAfter === "string" ? parseFloat(retryAfter) : 0;
        const retryMs = Math.ceil(retrySeconds * 1000);
        return reply.code(429).send({
          error: "rate_limit_exceeded",
          retry_after_ms: retryMs,
          request_id: requestId,
        });
      }

      const status = err instanceof TuttiError
        ? httpStatusForError(err)
        : (err as FastifyError).statusCode ?? 500;

      if (status >= 500) {
        logger.error({
          request_id: requestId,
          method: request.method,
          url: request.url,
          error: err.message,
          stack: err.stack,
        }, "Server error");
      }

      return reply.code(status).send(buildErrorBody(err, status, requestId));
    },
  );
}
