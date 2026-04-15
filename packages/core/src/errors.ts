/**
 * Typed error hierarchy for Tutti. All errors extend TuttiError.
 */

export class TuttiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

// ── Score ──────────────────────────────────────────────────────

export class ScoreValidationError extends TuttiError {
  constructor(message: string, context: { field?: string; value?: unknown } = {}) {
    super("SCORE_INVALID", message, context);
  }
}

// ── Agent ──────────────────────────────────────────────────────

export class AgentNotFoundError extends TuttiError {
  constructor(agentId: string, available: string[]) {
    super(
      "AGENT_NOT_FOUND",
      `Agent "${agentId}" not found in your score.\n` +
        `Available agents: ${available.join(", ")}\n` +
        `Check your tutti.score.ts — the agent ID must match the key in the agents object.`,
      { agent_id: agentId, available },
    );
  }
}

// ── Permissions ────────────────────────────────────────────────

export class PermissionError extends TuttiError {
  constructor(voice: string, required: string[], granted: string[]) {
    const missing = required.filter((p) => !granted.includes(p));
    super(
      "PERMISSION_DENIED",
      `Voice "${voice}" requires permissions not granted: ${missing.join(", ")}\n` +
        `Grant them in your score file:\n` +
        `  permissions: [${missing.map((p) => "'" + p + "'").join(", ")}]`,
      { voice, required, granted },
    );
  }
}

// ── Budget ─────────────────────────────────────────────────────

export class BudgetExceededError extends TuttiError {
  constructor(tokens: number, costUsd: number, limit: string) {
    super(
      "BUDGET_EXCEEDED",
      `Token budget exceeded: ${tokens.toLocaleString()} tokens, $${costUsd.toFixed(4)} (limit: ${limit}).`,
      { tokens, cost_usd: costUsd, limit },
    );
  }
}

// ── Tools ──────────────────────────────────────────────────────

export class ToolTimeoutError extends TuttiError {
  constructor(tool: string, timeoutMs: number) {
    super(
      "TOOL_TIMEOUT",
      `Tool "${tool}" timed out after ${timeoutMs}ms.\n` +
        `Increase tool_timeout_ms in your agent config, or check if the tool is hanging.`,
      { tool, timeout_ms: timeoutMs },
    );
  }
}

// ── Provider ───────────────────────────────────────────────────

export class ProviderError extends TuttiError {
  constructor(
    message: string,
    context: { provider: string; status?: number } & Record<string, unknown> = { provider: "unknown" },
  ) {
    super("PROVIDER_ERROR", message, context);
  }
}

export class AuthenticationError extends ProviderError {
  constructor(provider: string) {
    super(
      `Authentication failed for ${provider}.\n` +
        `Check that the API key is set correctly in your .env file.`,
      { provider },
    );
    Object.defineProperty(this, "code", { value: "AUTH_ERROR" });
  }
}

export class RateLimitError extends ProviderError {
  public readonly retryAfter?: number;

  constructor(provider: string, retryAfter?: number) {
    const msg = retryAfter
      ? `Rate limited by ${provider}. Retry after ${retryAfter}s.`
      : `Rate limited by ${provider}.`;
    super(msg, { provider, retryAfter });
    Object.defineProperty(this, "code", { value: "RATE_LIMIT" });
    this.retryAfter = retryAfter;
  }
}

export class ContextWindowError extends ProviderError {
  public readonly maxTokens?: number;

  constructor(provider: string, maxTokens?: number) {
    super(
      `Context window exceeded for ${provider}.` +
        (maxTokens ? ` Max: ${maxTokens.toLocaleString()} tokens.` : "") +
        `\nReduce message history or use a model with a larger context window.`,
      { provider, max_tokens: maxTokens },
    );
    Object.defineProperty(this, "code", { value: "CONTEXT_WINDOW" });
    this.maxTokens = maxTokens;
  }
}

// ── Guardrails ────────────────────────────────────────────────

export class GuardrailError extends TuttiError {
  constructor(message: string, context: { guardrail: string } & Record<string, unknown> = { guardrail: "unknown" }) {
    super("GUARDRAIL_BLOCKED", message, context);
  }
}

// ── Structured Output ─────────────────────────────────────────

export class StructuredOutputError extends TuttiError {
  public readonly rawOutput: string;

  constructor(rawOutput: string, lastError: string) {
    super(
      "STRUCTURED_OUTPUT_FAILED",
      `Structured output validation failed after max retries.\n` +
        `Last error: ${lastError}\n` +
        `Ensure the model can produce valid JSON matching the requested schema.`,
      { raw_output: rawOutput, last_error: lastError },
    );
    this.rawOutput = rawOutput;
  }
}

// ── Voice ──────────────────────────────────────────────────────

export class VoiceError extends TuttiError {
  constructor(message: string, context: { voice: string; tool?: string } & Record<string, unknown>) {
    super("VOICE_ERROR", message, context);
  }
}

export class PathTraversalError extends VoiceError {
  constructor(path: string) {
    super(
      `Path traversal detected: "${path}" is not allowed.\n` +
        `All file paths must stay within the allowed directory.`,
      { voice: "filesystem", path },
    );
    Object.defineProperty(this, "code", { value: "PATH_TRAVERSAL" });
  }
}

export class UrlValidationError extends VoiceError {
  constructor(url: string) {
    super(
      `URL blocked: "${url}".\n` +
        `Only http:// and https:// URLs to public hosts are allowed.`,
      { voice: "playwright", url },
    );
    Object.defineProperty(this, "code", { value: "URL_BLOCKED" });
  }
}

// ── Human-in-the-loop interrupts ──────────────────────────────

/**
 * Thrown when a human reviewer denies an approval-gated tool call. The
 * agent runner catches this, aborts the run, and surfaces the reason
 * to the caller so they can decide whether to retry with different
 * input or escalate.
 */
export class InterruptDeniedError extends TuttiError {
  constructor(
    public readonly tool_name: string,
    public readonly reason: string,
    public readonly interrupt_id: string,
  ) {
    super(
      "INTERRUPT_DENIED",
      `Tool "${tool_name}" denied by human reviewer: ${reason}`,
      { tool_name, reason, interrupt_id },
    );
  }
}
