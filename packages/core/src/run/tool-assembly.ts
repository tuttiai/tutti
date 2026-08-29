/**
 * Assemble the tool set a run executes against.
 *
 * An agent's callable tools come from four places, layered in this order:
 * its voices, the human-in-the-loop tool, its approved skills, and the
 * curated-memory tools. The set is fixed for the whole run — nothing here
 * changes between turns.
 */

import { randomUUID } from "node:crypto";
import type { AgentConfig, Tool, ToolDefinition } from "@tuttiai/types";
import type { EventBus } from "../event-bus.js";
import type { SemanticMemoryStore } from "../memory/semantic.js";
import type { SkillExecutor } from "../skills/executor.js";
import {
  MemoryEnforcer,
  createMemoryTools,
  DEFAULT_MAX_ENTRIES_PER_AGENT,
} from "../memory/curated.js";
import { toolToDefinition } from "./helpers.js";

/** Collaborators {@link assembleRunTools} needs from the runner. */
export interface ToolAssemblyDeps {
  /** The runtime-wide semantic memory store, when one is configured. */
  semanticMemory: SemanticMemoryStore | undefined;
  /** The skill executor, when skills are enabled. */
  skillExecutor: SkillExecutor | undefined;
  /** The event bus, passed to the memory enforcer so `memory:*` events fire. */
  events: EventBus;
  /** Builds the HITL tool for this agent and session. */
  createHitlTool: (agentName: string, sessionId: string) => Tool;
}

/** The assembled tool set, plus the memory objects the run reuses later. */
export interface AssembledRunTools {
  /** Every tool the agent can call this run. */
  allTools: Tool[];
  /** The provider-facing definitions for {@link allTools}. */
  toolDefs: ToolDefinition[];
  /** Per-run id correlating `skill:invoked` with the run-end trajectory. */
  runId: string;
  /** The resolved semantic store, when semantic memory is enabled. */
  semanticStore: SemanticMemoryStore | undefined;
  /** The enforcer backing both prompt injection and the curated tools. */
  memoryEnforcer: MemoryEnforcer | undefined;
}

/**
 * Initialise the agent's voices and build its tool set for one run.
 *
 * Voice `setup()` hooks run first — the MCP voice, for instance, discovers its
 * tools at this point, so the set is not knowable before this completes.
 *
 * The semantic memory config and store are resolved once here because two
 * consumers share them: the system-prompt injection later in the run, and the
 * `ToolContext.memory` helpers plus curated agent tools. Routing both through
 * the same {@link MemoryEnforcer} keeps the per-agent cap, LRU eviction and
 * `memory:*` events firing exactly once per logical operation.
 *
 * The curated tools are deliberately not a Voice: voices declare permissions
 * and carry setup/teardown hooks, neither of which applies to in-process
 * memory. They are appended directly.
 *
 * @param agent - The agent about to run.
 * @param sessionId - The session this run belongs to.
 * @param deps - Collaborators owned by the runner.
 * @returns The assembled tools and the memory objects the run reuses.
 * @throws When a skill's constituent tool breaches the agent's granted permissions.
 */
export async function assembleRunTools(
  agent: AgentConfig,
  sessionId: string,
  deps: ToolAssemblyDeps,
): Promise<AssembledRunTools> {
  // Initialize voices that have setup hooks (e.g., MCP voice discovers tools)
  const voiceCtx = { session_id: sessionId, agent_name: agent.name };
  for (const voice of agent.voices) {
    if (voice.setup) {
      await voice.setup(voiceCtx);
    }
  }

  // Per-run identifier shared between the SkillExecutor's
  // `skill:invoked` emissions and the TrajectoryObserver at run
  // end — same value at both call sites so subscribers can correlate.
  const runId = randomUUID();

  // Collect all tools from all voices
  const allTools: Tool[] = [...agent.voices.flatMap((v) => v.tools)];

  // Inject HITL tool if enabled
  if (agent.allow_human_input) {
    allTools.push(deps.createHitlTool(agent.name, sessionId));
  }

  // Project the agent's approved skills onto callable tools. The
  // executor closes over `runId` for `skill:invoked` correlation and
  // over the voice-tool pool so each skill's constituents resolve
  // against the tools this agent actually has. Permission breaches
  // throw at this call site (run start), not at skill invocation.
  if (deps.skillExecutor) {
    const skillTools = await deps.skillExecutor.toolsForAgent(agent.name, {
      tools: allTools,
      grantedPermissions: agent.permissions ?? [],
      runId,
    });
    allTools.push(...skillTools);
  }

  const semanticCfg = agent.memory?.semantic;
  const semanticStore: SemanticMemoryStore | undefined = semanticCfg?.enabled
    ? (semanticCfg.store ?? deps.semanticMemory)
    : undefined;
  const memoryEnforcer =
    semanticCfg?.enabled && semanticStore
      ? new MemoryEnforcer(
          semanticStore,
          agent.name,
          semanticCfg.max_entries_per_agent ?? DEFAULT_MAX_ENTRIES_PER_AGENT,
          deps.events,
        )
      : undefined;
  if (memoryEnforcer && semanticCfg?.curated_tools !== false) {
    allTools.push(...createMemoryTools({ enforcer: memoryEnforcer }));
  }

  const toolDefs = allTools.map(toolToDefinition);

  return { allTools, toolDefs, runId, semanticStore, memoryEnforcer };
}
