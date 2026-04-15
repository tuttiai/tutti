/**
 * `tutti-ai eval record <session-id>` — promote a past session run to a
 * golden eval case.
 *
 * Flow:
 *   1. Load the session (PostgreSQL if `TUTTI_PG_URL` is set, else the
 *      local `.tutti/sessions/<id>.json` log — which the future session
 *      logger will write into but which may legitimately be absent today).
 *   2. Print a summary so the operator can eyeball the input / output /
 *      tool sequence before promoting.
 *   3. Walk enquirer prompts for case name, expected output, tool sequence,
 *      scorers, and tags.
 *   4. Save to the default `.tutti/golden/` store.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import chalk from "chalk";
import Enquirer from "enquirer";
import {
  JsonFileGoldenStore,
  PostgresSessionStore,
  SecretsManager,
  createLogger,
  type GoldenCase,
  type ScorerRef,
  type Session,
} from "@tuttiai/core";

import {
  buildGoldenCase,
  deriveDefaultCaseName,
  extractSessionDraft,
  parseTagInput,
  parseToolSequenceInput,
  renderRecordedConfirmation,
  renderSessionSummary,
  type RecordAnswers,
} from "./eval-record-render.js";

const logger = createLogger("tutti-cli");
const { prompt } = Enquirer;

const LOCAL_SESSION_DIR = ".tutti/sessions";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function evalRecordCommand(sessionId: string): Promise<void> {
  const { session, close } = await resolveSession(sessionId);
  try {
    const draft = extractSessionDraft(session);
    console.log(renderSessionSummary(session, draft, undefined));
    console.log("");

    const answers = await collectAnswers(draft);
    const goldenCase = buildGoldenCase(session, draft, answers);

    const store = new JsonFileGoldenStore();
    const stored = await store.saveCase(goldenCase);
    console.log(renderRecordedConfirmation(stored));
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// Session resolution
// ---------------------------------------------------------------------------

interface ResolvedSession {
  session: Session;
  close: () => Promise<void>;
}

async function resolveSession(sessionId: string): Promise<ResolvedSession> {
  const pgUrl = SecretsManager.optional("TUTTI_PG_URL");
  if (pgUrl) {
    return loadFromPostgres(sessionId, pgUrl);
  }
  return loadFromLocalLog(sessionId);
}

async function loadFromPostgres(
  sessionId: string,
  pgUrl: string,
): Promise<ResolvedSession> {
  const store = new PostgresSessionStore(pgUrl);
  let session: Session | undefined;
  try {
    session = await store.getAsync(sessionId);
  } catch (err) {
    await store.close();
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "Session store error",
    );
    process.exit(1);
  }
  if (!session) {
    await store.close();
    exitSessionNotFound(sessionId, "postgres");
  }
  return { session, close: () => store.close() };
}

async function loadFromLocalLog(sessionId: string): Promise<ResolvedSession> {
  const path = resolve(join(LOCAL_SESSION_DIR, sessionId + ".json"));
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    exitSessionNotFound(sessionId, "local");
  }
  const parsed: unknown = JSON.parse(raw);
  const session = reviveLocalSession(parsed);
  return { session, close: () => Promise.resolve() };
}

function reviveLocalSession(raw: unknown): Session {
  const obj = raw as Session & { created_at: string | Date; updated_at: string | Date };
  return {
    ...obj,
    created_at: new Date(obj.created_at),
    updated_at: new Date(obj.updated_at),
  };
}

function exitSessionNotFound(sessionId: string, source: "postgres" | "local"): never {
  console.error(chalk.red("Session not found: " + sessionId));
  if (source === "postgres") {
    console.error(
      chalk.dim(
        "  Checked the Postgres session store at TUTTI_PG_URL. " +
          "Verify the id and that the env var points at the right database.",
      ),
    );
  } else {
    console.error(
      chalk.dim(
        "  TUTTI_PG_URL is unset and no local log exists at " +
          LOCAL_SESSION_DIR +
          "/" +
          sessionId +
          ".json.\n" +
          "  Set TUTTI_PG_URL to pull the session from Postgres.",
      ),
    );
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

async function collectAnswers(draft: {
  input: string;
  output: string;
  tool_sequence: string[];
}): Promise<RecordAnswers> {
  const { name } = await prompt<{ name: string }>({
    type: "input",
    name: "name",
    message: "Case name?",
    initial: deriveDefaultCaseName(draft.input) || "unnamed-case",
  });

  const expected_mode = await promptExpectedMode();
  const expected_output_custom =
    expected_mode === "custom" ? await promptCustomExpected() : undefined;

  const tool_sequence = await promptToolSequence(draft.tool_sequence);
  const scorers = await promptScorers(expected_mode, tool_sequence.length > 0);

  const { tagsRaw } = await prompt<{ tagsRaw: string }>({
    type: "input",
    name: "tagsRaw",
    message: "Tags (comma-separated, optional)?",
    initial: "",
  });

  return {
    name: name.trim() === "" ? deriveDefaultCaseName(draft.input) : name.trim(),
    expected_mode,
    ...(expected_output_custom !== undefined ? { expected_output_custom } : {}),
    tool_sequence,
    scorers,
    tags: parseTagInput(tagsRaw),
  };
}

async function promptExpectedMode(): Promise<"actual" | "custom" | "skip"> {
  const { choice } = await prompt<{ choice: string }>({
    type: "select",
    name: "choice",
    message: "Expected output?",
    choices: [
      { name: "actual", message: "Use the actual output from this run (exact match)" },
      { name: "custom", message: "Enter a custom expected output" },
      { name: "skip", message: "Skip — rely on tool-sequence / custom scorers" },
    ],
  });
  if (choice === "actual" || choice === "custom" || choice === "skip") return choice;
  return "skip";
}

async function promptCustomExpected(): Promise<string> {
  const { expected } = await prompt<{ expected: string }>({
    type: "input",
    name: "expected",
    message: "Custom expected output:",
  });
  return expected;
}

async function promptToolSequence(actual: string[]): Promise<string[]> {
  const initial = actual.join(", ");
  const { edited } = await prompt<{ edited: string }>({
    type: "input",
    name: "edited",
    message: "Expected tool sequence (comma-separated, empty to skip)?",
    initial,
  });
  return parseToolSequenceInput(edited);
}

async function promptScorers(
  expectedMode: "actual" | "custom" | "skip",
  hasToolSequence: boolean,
): Promise<ScorerRef[]> {
  const defaults: string[] = [];
  if (expectedMode !== "skip") defaults.push("exact");
  if (hasToolSequence) defaults.push("tool-sequence");

  // Enquirer's bundled .d.ts lists `select`/`input`/`confirm` but omits
  // `multiselect`, which is a documented built-in at runtime. Cast so
  // the prompt options typecheck without reaching for `any`.
  const multiselectOpts: Parameters<typeof prompt>[0] = {
    type: "multiselect",
    name: "picked",
    message: "Scorers to attach?",
    choices: [
      { name: "exact", message: "Exact output match" },
      { name: "similarity", message: "Cosine similarity" },
      { name: "tool-sequence", message: "Tool sequence match" },
      { name: "custom", message: "Custom scorer module" },
    ],
    initial: defaults,
  } as unknown as Parameters<typeof prompt>[0];
  const { picked } = await prompt<{ picked: string[] }>(multiselectOpts);

  const refs: ScorerRef[] = [];
  for (const kind of picked) {
    if (kind === "custom") {
      const { path } = await prompt<{ path: string }>({
        type: "input",
        name: "path",
        message: "Custom scorer module path (relative to CWD)?",
      });
      refs.push({ type: "custom", path: path.trim() });
    } else if (kind === "exact" || kind === "similarity" || kind === "tool-sequence") {
      refs.push({ type: kind });
    }
  }
  return refs;
}

// Re-export the type so the index can pass through.
export type { GoldenCase };
