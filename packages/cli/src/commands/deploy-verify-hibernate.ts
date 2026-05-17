import { existsSync } from "node:fs";
import { resolve } from "node:path";

import chalk from "chalk";
import { ScoreLoader } from "@tuttiai/core";
import type { AgentConfig, ScoreConfig } from "@tuttiai/types";

/**
 * Options accepted by `tutti-ai deploy verify-hibernate`. Mirrors the
 * commander flag set so the command body stays a thin wrapper around the
 * pure {@link buildHibernationReport}.
 */
export interface VerifyHibernateOptions {
  score?: string;
}

/** Where a store keeps its state, as far as the score can tell us. */
export type HibernationStoreKind = "postgres" | "redis" | "memory" | "none";

/**
 * One row in the hibernation report. `error`-level failures break the
 * contract and exit the CLI with code 1; `warning`-level ones print but
 * still exit 0. `skipped` is reserved for checks that don't apply to this
 * score (e.g. the skills-store check when `score.skills.enabled` is false).
 */
export interface HibernationCheck {
  label: string;
  status: "pass" | "fail" | "skipped";
  level: "error" | "warning";
  detail?: string;
}

/**
 * Pure summary of how well a score satisfies the serverless-hibernation
 * contract. Built by {@link buildHibernationReport} from the loaded
 * {@link ScoreConfig} — no I/O, so the verify command's logic is testable
 * without spinning up real stores.
 */
export interface HibernationReport {
  checks: HibernationCheck[];
  /**
   * Rough sum of typical store-reconnect latencies under cold start.
   * In-memory stores contribute 0ms — accurate, but misleading because the
   * state is gone too. Printed as guidance, never used for gating.
   */
  estimatedColdStartMs: number;
  /** Count of `fail` checks at `error` level — drives the exit code. */
  errorCount: number;
  /** Count of `fail` checks at `warning` level — informational only. */
  warningCount: number;
}

const POSTGRES_RECONNECT_MS = 200;
const REDIS_RECONNECT_MS = 50;

/**
 * Typical cold-start reconnect latency for one store of the given kind.
 * Numbers are deliberately conservative — meant as a "is this seconds or
 * milliseconds" guide, not a benchmark.
 */
function reconnectLatencyMs(kind: HibernationStoreKind): number {
  switch (kind) {
    case "postgres":
      return POSTGRES_RECONNECT_MS;
    case "redis":
      return REDIS_RECONNECT_MS;
    case "memory":
    case "none":
      return 0;
  }
}

/**
 * Resolve the configured checkpoint store for one agent. `durable: true`
 * accepts the runtime default (memory); `durable: { store: "..." }` pins
 * the backing store; an absent `durable` declares no checkpoint store at
 * all.
 */
function agentCheckpointStore(agent: AgentConfig): HibernationStoreKind {
  const durable = agent.durable;
  if (durable === undefined || durable === false) return "none";
  if (durable === true) return "memory";
  return durable.store;
}

/**
 * Reduce the per-agent checkpoint stores to one "dominant" kind for the
 * whole score. Preference order: postgres > redis > memory > none — the
 * weakest link wins so the report flags any in-memory agent.
 */
function dominantCheckpointStore(
  score: ScoreConfig,
): HibernationStoreKind {
  let result: HibernationStoreKind = "none";
  for (const agent of Object.values(score.agents)) {
    const kind = agentCheckpointStore(agent);
    if (kind === "memory" && result !== "memory") result = "memory";
    else if (kind === "redis" && result !== "memory") result = "redis";
    else if (kind === "postgres" && result === "none") result = "postgres";
  }
  return result;
}

function memoryProviderKind(score: ScoreConfig): HibernationStoreKind {
  const provider = score.memory?.provider;
  if (provider === "postgres") return "postgres";
  if (provider === "redis") return "redis";
  if (provider === "in-memory") return "memory";
  return "none";
}

function anyAgentEnablesUserModel(score: ScoreConfig): boolean {
  for (const agent of Object.values(score.agents)) {
    if (agent.memory?.user_model?.enabled === true) return true;
  }
  return false;
}

function voiceDeclaresRestorable(voice: unknown): boolean {
  if (typeof voice !== "object" || voice === null) return false;
  const rec = voice as Record<string, unknown>;
  return rec.restorable_state === true;
}

/**
 * Walk every voice on every agent and report which ones omit
 * `restorable_state: true`. Returns `{ total: 0, ... }` when the score
 * declares no voices at all — the caller treats that as "skip the check".
 */
function auditRestorableVoices(score: ScoreConfig): {
  total: number;
  missing: Array<{ agent: string; voice: string }>;
} {
  let total = 0;
  const missing: Array<{ agent: string; voice: string }> = [];
  for (const [agentName, agent] of Object.entries(score.agents)) {
    for (const voice of agent.voices) {
      total++;
      if (!voiceDeclaresRestorable(voice)) {
        missing.push({ agent: agentName, voice: voice.name });
      }
    }
  }
  return { total, missing };
}

/**
 * Compose the per-check rows. Split out from {@link buildHibernationReport}
 * so the latency / counter aggregation stays in one place.
 */
function composeChecks(score: ScoreConfig): HibernationCheck[] {
  const checks: HibernationCheck[] = [];

  // 1 — Checkpoint store
  const ckpt = dominantCheckpointStore(score);
  if (ckpt === "postgres" || ckpt === "redis") {
    checks.push({
      label: "Checkpoint store is durable",
      status: "pass",
      level: "error",
      detail: `agents declare durable.store = "${ckpt}"`,
    });
  } else if (ckpt === "memory") {
    checks.push({
      label: "Checkpoint store is durable",
      status: "fail",
      level: "error",
      detail: "at least one agent uses durable.store = \"memory\" (or durable: true). Set durable: { store: \"postgres\" } to survive cold starts.",
    });
  } else {
    checks.push({
      label: "Checkpoint store is durable",
      status: "fail",
      level: "error",
      detail: "no agent declares `durable` — in-flight runs cannot resume after hibernation. Add durable: { store: \"postgres\" } to the deployed agent.",
    });
  }

  // 2 — Session memory store
  const memKind = memoryProviderKind(score);
  if (memKind === "postgres" || memKind === "redis") {
    checks.push({
      label: "Session memory store is durable",
      status: "pass",
      level: "error",
      detail: `memory.provider = "${memKind}"`,
    });
  } else {
    checks.push({
      label: "Session memory store is durable",
      status: "fail",
      level: "error",
      detail: memKind === "memory"
        ? "memory.provider = \"in-memory\" — sessions evaporate on cold start. Switch to \"postgres\" or \"redis\"."
        : "memory.provider is unset — defaults to in-memory. Declare memory: { provider: \"postgres\", url: ... }.",
    });
  }

  // 3 — User-model store (warning only)
  if (anyAgentEnablesUserModel(score)) {
    if (memKind === "postgres" || memKind === "redis") {
      checks.push({
        label: "User-model store is durable",
        status: "pass",
        level: "warning",
        detail: `consolidator reads from memory.provider = "${memKind}"`,
      });
    } else {
      checks.push({
        label: "User-model store is durable",
        status: "fail",
        level: "warning",
        detail: "memory.user_model.enabled but the consolidator reads from an in-memory store — the rolling profile resets on cold start.",
      });
    }
  } else {
    checks.push({
      label: "User-model store is durable",
      status: "skipped",
      level: "warning",
      detail: "no agent enables memory.user_model — nothing to verify",
    });
  }

  // 4 — Skill store (warning only)
  if (score.skills?.enabled === true) {
    checks.push({
      label: "SkillStore is durable",
      status: "fail",
      level: "warning",
      detail: "score.skills.enabled is true. The SkillStore is wired at runtime via TuttiRuntimeOptions.skillStore — verify it points at a durable backend, not InMemorySkillStore.",
    });
  } else {
    checks.push({
      label: "SkillStore is durable",
      status: "skipped",
      level: "warning",
      detail: "score.skills.enabled is false — nothing to verify",
    });
  }

  // 5 — Voices declare restorable_state (warning only)
  const audit = auditRestorableVoices(score);
  if (audit.total === 0) {
    checks.push({
      label: "Voices declare restorable_state",
      status: "skipped",
      level: "warning",
      detail: "score has no voices — no in-flight tool state to restore",
    });
  } else if (audit.missing.length === 0) {
    checks.push({
      label: "Voices declare restorable_state",
      status: "pass",
      level: "warning",
      detail: `${String(audit.total)}/${String(audit.total)} voices declare restorable_state: true`,
    });
  } else {
    const examples = audit.missing
      .slice(0, 3)
      .map((m) => `${m.agent}.${m.voice}`)
      .join(", ");
    const more = audit.missing.length > 3 ? ` (+${String(audit.missing.length - 3)} more)` : "";
    checks.push({
      label: "Voices declare restorable_state",
      status: "fail",
      level: "warning",
      detail: `${String(audit.missing.length)} voice(s) omit restorable_state: true — in-flight tool calls in ${examples}${more} will lose state across hibernation.`,
    });
  }

  return checks;
}

/**
 * Inspect a loaded score and report whether it satisfies the contract for
 * serverless hibernation (state survives cold start). Pure: no I/O, so the
 * orchestrator can test all branches without spinning up real stores.
 */
export function buildHibernationReport(score: ScoreConfig): HibernationReport {
  const checks = composeChecks(score);
  let errorCount = 0;
  let warningCount = 0;
  for (const c of checks) {
    if (c.status !== "fail") continue;
    if (c.level === "error") errorCount++;
    else warningCount++;
  }
  const estimatedColdStartMs =
    reconnectLatencyMs(dominantCheckpointStore(score)) +
    reconnectLatencyMs(memoryProviderKind(score));
  return { checks, estimatedColdStartMs, errorCount, warningCount };
}

function statusGlyph(check: HibernationCheck): string {
  if (check.status === "pass") return chalk.green("✔");
  if (check.status === "skipped") return chalk.dim("→");
  return check.level === "error" ? chalk.red("✘") : chalk.yellow("⚠");
}

/**
 * Render a {@link HibernationReport} for the terminal. One row per check,
 * indented two spaces (matches the surrounding `deploy` output style),
 * followed by the estimated cold-start latency line.
 */
export function formatHibernationReport(report: HibernationReport): string {
  const lines: string[] = [];
  for (const c of report.checks) {
    lines.push(`  ${statusGlyph(c)} ${c.label}`);
    if (c.detail !== undefined) {
      lines.push(chalk.dim(`      ${c.detail}`));
    }
  }
  lines.push("");
  lines.push(chalk.dim(`  Estimated cold-start reconnect: ~${String(report.estimatedColdStartMs)}ms`));
  return lines.join("\n");
}

function fail(msg: string): never {
  console.error(chalk.red("  " + msg));
  process.exit(1);
}

/**
 * `tutti-ai deploy verify-hibernate` entrypoint. Loads the score, runs
 * {@link buildHibernationReport}, prints the rendered report, and exits
 * with code 1 iff any `error`-level check failed.
 */
export async function verifyHibernateCommand(
  opts: VerifyHibernateOptions,
): Promise<void> {
  const file = resolve(opts.score ?? "./tutti.score.ts");
  if (!existsSync(file)) {
    fail("Score file not found: " + file);
  }

  let score: ScoreConfig;
  try {
    score = await ScoreLoader.load(file);
  } catch (err) {
    fail("Score validation failed: " + (err instanceof Error ? err.message : String(err)));
  }

  console.log();
  console.log(chalk.bold("  Hibernation contract check"));
  console.log();
  const report = buildHibernationReport(score);
  console.log(formatHibernationReport(report));
  console.log();

  if (report.errorCount > 0) {
    console.error(
      chalk.red(
        `  ${String(report.errorCount)} error(s) — score does not satisfy the hibernation contract.`,
      ),
    );
    process.exit(1);
  }
  if (report.warningCount > 0) {
    console.log(
      chalk.yellow(
        `  ${String(report.warningCount)} warning(s) — review before deploying to a serverless target.`,
      ),
    );
  } else {
    console.log(chalk.green("  Hibernation contract satisfied."));
  }
}
