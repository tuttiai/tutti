import type {
  AgentConfig,
  AgentUserMemoryConfig,
  AgentUserModelConfig,
  LLMProvider,
} from "@tuttiai/types";
import type { EventBus } from "../event-bus.js";
import { createUserMemoryStore } from "../memory/user/index.js";
import { MemoryUserMemoryStore } from "../memory/user/memory-store.js";
import type { UserMemoryStore } from "../memory/user/types.js";
import { InMemoryUserModelStore, type UserModelStore } from "../memory/user-model.js";
import {
  UserModelConsolidator,
  type UserModelConsolidatorOptions,
} from "../memory/consolidator.js";

/** An agent's resolved user-memory store and the config it was built from. */
export interface UserMemoryWiring {
  store: UserMemoryStore;
  cfg: AgentUserMemoryConfig;
}

/** An agent's dialectic-user-model store and the consolidator that refreshes it. */
export interface UserModelWiring {
  store: UserModelStore;
  consolidator: UserModelConsolidator;
}

/**
 * Map an agent's `user_model` config onto consolidator options, copying
 * across only the fields that are set so the consolidator's own
 * defaults apply to the rest.
 */
export function consolidatorOptions(
  cfg: AgentUserModelConfig,
  events: EventBus,
): UserModelConsolidatorOptions {
  return {
    ...(cfg.every_n_turns !== undefined ? { every_n_turns: cfg.every_n_turns } : {}),
    ...(cfg.consolidation_model !== undefined ? { model: cfg.consolidation_model } : {}),
    ...(cfg.recent_memory_limit !== undefined
      ? { recent_memory_limit: cfg.recent_memory_limit }
      : {}),
    events,
  };
}

/**
 * Per-runner registry of the per-agent user-memory stores and user-model
 * wiring. Internal to `AgentRunner`: one instance per runner, so state
 * is never shared between runners.
 */
export class RunnerMemoryRegistry {
  /**
   * Lazily-constructed user-memory stores keyed by agent name. One store
   * per agent so different agents can pick different backends. Tests
   * pre-populate via {@link setUserMemoryStore} to inject mocks.
   */
  private readonly userMemoryStores = new Map<string, UserMemoryStore>();
  /**
   * Per-agent dialectic-user-model wiring. The consolidator is the live
   * object the runtime calls; the store is exposed alongside so the
   * runtime's profile-inject path and tests share one state surface.
   * Built lazily from `agent.memory.user_model` on first use.
   */
  private readonly userModelWiring = new Map<string, UserModelWiring>();
  /**
   * Test-seam overrides for {@link UserModelStore}, keyed by agent name.
   * Set via {@link setUserModelStore}; read by {@link userModelFor}.
   */
  private readonly userModelStoreOverrides = new Map<string, UserModelStore>();

  constructor(
    private readonly provider: LLMProvider,
    private readonly events: EventBus,
  ) {}

  /** Pre-register a user-memory store for an agent. */
  setUserMemoryStore(agent_name: string, store: UserMemoryStore): void {
    this.userMemoryStores.set(agent_name, store);
  }

  /**
   * Pre-register a user-model store for an agent. If a consolidator was
   * already built with the default store, drop it so the next run
   * rebuilds against the override.
   */
  setUserModelStore(agent_name: string, store: UserModelStore): void {
    this.userModelStoreOverrides.set(agent_name, store);
    this.userModelWiring.delete(agent_name);
  }

  /**
   * Resolve the user-memory store for an agent, constructing it lazily
   * from `agent.memory.user_memory` config on first use. Returns
   * `undefined` when the agent has no user-memory configuration.
   */
  userMemoryFor(agent: AgentConfig): UserMemoryWiring | undefined {
    const cfg = agent.memory?.user_memory;
    if (!cfg) return undefined;
    let store = this.userMemoryStores.get(agent.name);
    if (!store) {
      store = createUserMemoryStore(cfg);
      this.userMemoryStores.set(agent.name, store);
    }
    return { store, cfg };
  }

  /**
   * Resolve the dialectic-user-model wiring for an agent, constructing
   * it lazily from `agent.memory.user_model` on first use. Returns
   * `undefined` when the agent has no user-model configuration or it
   * is disabled. The consolidator pulls source signal from the same
   * agent's `user_memory` store; agents with `user_model` but no
   * `user_memory` get an empty ephemeral store, so the consolidator
   * bootstraps off an empty memory list.
   */
  userModelFor(agent: AgentConfig): UserModelWiring | undefined {
    const cfg = agent.memory?.user_model;
    if (!cfg || cfg.enabled === false) return undefined;

    const cached = this.userModelWiring.get(agent.name);
    if (cached) return cached;

    const store =
      this.userModelStoreOverrides.get(agent.name) ?? new InMemoryUserModelStore();
    const memoryStore = this.userMemoryFor(agent)?.store ?? new MemoryUserMemoryStore();
    const consolidator = new UserModelConsolidator(
      store,
      memoryStore,
      this.provider,
      consolidatorOptions(cfg, this.events),
    );

    const wiring = { store, consolidator };
    this.userModelWiring.set(agent.name, wiring);
    return wiring;
  }
}
