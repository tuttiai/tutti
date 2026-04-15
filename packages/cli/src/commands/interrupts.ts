/**
 * `tutti-ai interrupts` / `tutti-ai approve` — review and resolve
 * approval-gated tool calls against a running `tutti-ai serve`.
 *
 * Five entry points:
 * - {@link interruptsTUICommand} — full-screen TUI, polls the server
 *   every {@link POLL_INTERVAL_MS} and lets the reviewer page through
 *   pending items with keypresses.
 * - {@link interruptsListCommand} — one-shot table print for CI /
 *   scripting.
 * - {@link interruptsApproveCommand} / {@link interruptsDenyCommand} —
 *   direct resolution by id.
 *
 * This file is excluded from coverage — the raw-stdin keypress loop,
 * interval polling, and HTTP fetching are hard to unit-test
 * meaningfully without spinning up a full stack. The pure rendering
 * lives in {@link ./interrupts-render.js} and is fully covered.
 */

import chalk from "chalk";
import Enquirer from "enquirer";
import { SecretsManager } from "@tuttiai/core";
import type { InterruptRequest } from "@tuttiai/core";

import {
  renderApproved,
  renderDenied,
  renderInterruptDetail,
  renderInterruptsList,
} from "./interrupts-render.js";

const { prompt } = Enquirer;

const DEFAULT_SERVER_URL = "http://127.0.0.1:3847";
const POLL_INTERVAL_MS = 2_000;

/** Common command-line options shared by every subcommand. */
export interface InterruptsOptions {
  /** Base URL of the `tutti-ai serve` process. Defaults to localhost:3847. */
  url?: string;
  /** Bearer token. Falls back to `TUTTI_API_KEY` env var. */
  apiKey?: string;
}

function resolveUrl(opts: InterruptsOptions): string {
  return (
    opts.url ?? SecretsManager.optional("TUTTI_SERVER_URL") ?? DEFAULT_SERVER_URL
  );
}

function resolveAuthHeader(opts: InterruptsOptions): Record<string, string> {
  const key = opts.apiKey ?? SecretsManager.optional("TUTTI_API_KEY");
  return key ? { Authorization: "Bearer " + key } : {};
}

function explainConnectionError(err: unknown, baseUrl: string): never {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(chalk.red("Failed to reach Tutti server at " + baseUrl));
  console.error(chalk.dim("  " + msg));
  console.error(
    chalk.dim('  Is `tutti-ai serve` running? Set --url or TUTTI_SERVER_URL to override.'),
  );
  process.exit(1);
}

/**
 * Revive the wire format (ISO strings) back to the runtime
 * {@link InterruptRequest} shape (`Date` objects). The render
 * functions expect `Date`s so they can compute relative-time strings.
 */
function reviveInterrupt(wire: Record<string, unknown>): InterruptRequest {
  const req: InterruptRequest = {
    interrupt_id: wire["interrupt_id"] as string,
    session_id: wire["session_id"] as string,
    tool_name: wire["tool_name"] as string,
    tool_args: wire["tool_args"],
    requested_at: new Date(wire["requested_at"] as string),
    status: wire["status"] as InterruptRequest["status"],
  };
  if (typeof wire["resolved_at"] === "string") {
    req.resolved_at = new Date(wire["resolved_at"]);
  }
  if (typeof wire["resolved_by"] === "string") {
    req.resolved_by = wire["resolved_by"];
  }
  if (typeof wire["denial_reason"] === "string") {
    req.denial_reason = wire["denial_reason"];
  }
  return req;
}

/* ------------------------------------------------------------------ */
/*  HTTP helpers                                                       */
/* ------------------------------------------------------------------ */

async function httpJson<T>(
  opts: InterruptsOptions,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: T }> {
  const baseUrl = resolveUrl(opts);
  const url = baseUrl.replace(/\/$/, "") + path;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...resolveAuthHeader(opts),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    explainConnectionError(err, baseUrl);
  }
  // Empty-body 204 never happens here but guard anyway.
  const text = await res.text();
  const parsed = (text === "" ? null : JSON.parse(text)) as T;
  return { status: res.status, body: parsed };
}

async function fetchPending(opts: InterruptsOptions): Promise<InterruptRequest[]> {
  const { status, body } = await httpJson<{ interrupts: Record<string, unknown>[] } | { error: string; message: string }>(
    opts,
    "GET",
    "/interrupts/pending",
  );
  if (status === 401) {
    console.error(chalk.red("Unauthorized — set --api-key or TUTTI_API_KEY."));
    process.exit(1);
  }
  if (status === 503) {
    console.error(
      chalk.red(
        "The server has no InterruptStore configured. " +
          "Start `tutti-ai serve` with an interrupt store attached.",
      ),
    );
    process.exit(1);
  }
  if (status < 200 || status >= 300 || !("interrupts" in body)) {
    console.error(chalk.red("Unexpected server response: " + status));
    process.exit(1);
  }
  return body.interrupts.map(reviveInterrupt);
}

async function postResolve(
  opts: InterruptsOptions,
  interruptId: string,
  action: "approve" | "deny",
  payload: Record<string, unknown>,
): Promise<InterruptRequest> {
  const { status, body } = await httpJson<Record<string, unknown>>(
    opts,
    "POST",
    "/interrupts/" + encodeURIComponent(interruptId) + "/" + action,
    payload,
  );
  if (status === 401) {
    console.error(chalk.red("Unauthorized — set --api-key or TUTTI_API_KEY."));
    process.exit(1);
  }
  if (status === 404) {
    console.error(chalk.red('Interrupt "' + interruptId + '" not found.'));
    process.exit(1);
  }
  if (status === 409) {
    const current = (body as { current?: Record<string, unknown> }).current;
    const currentStatus =
      current && typeof current["status"] === "string" ? current["status"] : "resolved";
    console.error(
      chalk.red("Interrupt already " + currentStatus + " — refusing to override."),
    );
    process.exit(1);
  }
  if (status < 200 || status >= 300) {
    console.error(chalk.red("Unexpected server response: " + status));
    process.exit(1);
  }
  return reviveInterrupt(body);
}

/* ------------------------------------------------------------------ */
/*  list                                                               */
/* ------------------------------------------------------------------ */

export async function interruptsListCommand(
  opts: InterruptsOptions,
): Promise<void> {
  const pending = await fetchPending(opts);
  console.log(renderInterruptsList(pending));
}

/* ------------------------------------------------------------------ */
/*  approve / deny (direct, non-interactive)                           */
/* ------------------------------------------------------------------ */

export async function interruptsApproveCommand(
  interruptId: string,
  opts: InterruptsOptions & { resolvedBy?: string },
): Promise<void> {
  const resolved = await postResolve(opts, interruptId, "approve", {
    ...(opts.resolvedBy !== undefined ? { resolved_by: opts.resolvedBy } : {}),
  });
  console.log(renderApproved(resolved));
}

export async function interruptsDenyCommand(
  interruptId: string,
  opts: InterruptsOptions & { reason?: string; resolvedBy?: string },
): Promise<void> {
  const resolved = await postResolve(opts, interruptId, "deny", {
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    ...(opts.resolvedBy !== undefined ? { resolved_by: opts.resolvedBy } : {}),
  });
  console.log(renderDenied(resolved));
}

/* ------------------------------------------------------------------ */
/*  Interactive TUI                                                    */
/* ------------------------------------------------------------------ */

/** Clear the terminal and return the cursor home. */
function clearScreen(): void {
  process.stdout.write("\u001b[2J\u001b[H");
}

/**
 * Return the next single keypress from stdin. Puts the TTY into raw
 * mode for the duration of the wait and restores it before resolving,
 * so the returned promise is safe to race against a timeout.
 *
 * Returns `null` if stdin is not a TTY — tests and piped invocations
 * fall through to the one-shot list view by checking this upstream.
 */
function readKey(): Promise<string | null> {
  const input = process.stdin;
  if (!input.isTTY) return Promise.resolve(null);

  return new Promise((resolve) => {
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const onData = (data: string): void => {
      input.removeListener("data", onData);
      input.setRawMode(false);
      input.pause();
      resolve(data);
    };
    input.on("data", onData);
  });
}

/** Race a keypress against a timeout. Returns `null` on timeout. */
async function readKeyOrTimeout(ms: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    const winner = await Promise.race([readKey(), timeout]);
    return winner;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Interactive review loop. Clears the screen, prints the pending
 * table, waits up to {@link POLL_INTERVAL_MS} for a keypress, then
 * either re-polls or dispatches to the detail view on selection.
 */
export async function interruptsTUICommand(
  opts: InterruptsOptions,
): Promise<void> {
  // Fall through to the non-interactive listing when stdin isn't a
  // TTY (piped, redirected, captured in tests) — the poll loop would
  // otherwise spin forever with no way to advance.
  if (!process.stdin.isTTY) {
    await interruptsListCommand(opts);
    return;
  }

  // SIGINT cleanup: restore the TTY so the user's shell isn't left in
  // raw mode if they Ctrl+C mid-poll.
  const sigint = (): void => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write("\n");
    process.exit(0);
  };
  process.on("SIGINT", sigint);

  try {
    for (;;) {
      const pending = await fetchPending(opts);
      clearScreen();
      console.log(
        chalk.bold("Tutti — pending interrupts") +
          chalk.dim("   (auto-refresh every " + POLL_INTERVAL_MS / 1000 + "s)"),
      );
      console.log(renderInterruptsList(pending));
      if (pending.length > 0) {
        console.log(
          chalk.dim(
            "Press a number to inspect, 'r' to refresh, 'q' to quit.",
          ),
        );
      } else {
        console.log(chalk.dim("Press 'r' to refresh, 'q' to quit."));
      }

      // Index the visible list so digit keys pick the n-th row. The
      // server already returns oldest-first so numbering is stable
      // within one page.
      const indexed = pending.slice(0, 9); // single-digit selection only

      const key = await readKeyOrTimeout(POLL_INTERVAL_MS);
      if (key === null) continue; // timeout → repoll
      if (key === "q" || key === "\u0003" /* Ctrl+C */) return;
      if (key === "r") continue; // explicit refresh

      const digit = parseInt(key, 10);
      if (!Number.isNaN(digit) && digit >= 1 && digit <= indexed.length) {
        const chosen = indexed[digit - 1];
        const shouldContinue = await runDetailView(opts, chosen);
        if (!shouldContinue) return;
      }
      // Any other key just falls through to the next poll iteration.
    }
  } finally {
    process.off("SIGINT", sigint);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  }
}

/**
 * Detail view with approve / deny / back. Returns `false` when the
 * reviewer has chosen to exit the TUI entirely (e.g. after resolving
 * the last pending item they want to process), `true` to return to
 * the list loop.
 */
async function runDetailView(
  opts: InterruptsOptions,
  interrupt: InterruptRequest,
): Promise<boolean> {
  clearScreen();
  console.log(renderInterruptDetail(interrupt));
  console.log(
    chalk.dim(
      "Press 'a' to approve, 'd' to deny, 'q' to go back to the list.",
    ),
  );

  const key = await readKey();
  if (key === null || key === "q" || key === "\u0003") return true;

  if (key === "a") {
    const resolved = await postResolve(opts, interrupt.interrupt_id, "approve", {});
    clearScreen();
    console.log(renderApproved(resolved));
    await pause();
    return true;
  }

  if (key === "d") {
    // Prompt for a reason via enquirer — this releases raw mode for
    // the duration of the prompt because enquirer owns the tty.
    const { reason } = await prompt<{ reason: string }>({
      type: "input",
      name: "reason",
      message: "Reason (optional):",
    });
    const payload: Record<string, unknown> = {};
    if (reason && reason.trim() !== "") payload["reason"] = reason.trim();
    const resolved = await postResolve(
      opts,
      interrupt.interrupt_id,
      "deny",
      payload,
    );
    clearScreen();
    console.log(renderDenied(resolved));
    await pause();
    return true;
  }

  // Unrecognised key — drop back to the list.
  return true;
}

/** Print a "press any key" prompt and wait — used after a resolve. */
async function pause(): Promise<void> {
  console.log(chalk.dim("\nPress any key to continue..."));
  await readKey();
}
