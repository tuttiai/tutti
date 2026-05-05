import { useState, type FormEvent, type KeyboardEvent } from "react";

import { runAgent } from "../api.js";
import type { RunStatus } from "../hooks/useExecutionStream.js";

interface RunBarProps {
  /** Live run status — drives the button's enabled state. */
  status: RunStatus;
}

/**
 * Header input + Run button. POSTs the typed text to `/run` and lets
 * the server's graph runner take over — execution updates come back
 * through the `useExecutionStream` SSE bus, not from this fetch.
 *
 * The button stays disabled while a run is in flight to prevent the
 * user from racing two graph runs through the same canvas.
 */
export function RunBar({ status }: RunBarProps) {
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disabled = submitting || status === "running" || input.trim().length === 0;

  const submit = async (): Promise<void> => {
    if (input.trim().length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await runAgent({ input });
      setInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    void submit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form className="run-bar" onSubmit={onSubmit}>
      <input
        type="text"
        className="run-bar__input"
        placeholder="Type an input and press Run…"
        aria-label="Agent input"
        value={input}
        onChange={(e): void => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        autoComplete="off"
      />
      <button type="submit" className="run-bar__button" disabled={disabled}>
        {submitting || status === "running" ? "Running…" : "Run"}
      </button>
      {error !== null ? (
        <span className="run-bar__error" role="alert">
          {error}
        </span>
      ) : null}
    </form>
  );
}
