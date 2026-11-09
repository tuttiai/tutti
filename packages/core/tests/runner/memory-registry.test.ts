import { afterEach, describe, it, expect, vi } from "vitest";
import type { AgentConfig } from "@tuttiai/types";

import { RunnerMemoryRegistry, consolidatorOptions } from "../../src/runner/memory-registry.js";
import { EventBus } from "../../src/event-bus.js";
import { MemoryUserMemoryStore } from "../../src/memory/user/memory-store.js";
import { InMemoryUserModelStore } from "../../src/memory/user-model.js";
import { createMockProvider, simpleAgent } from "../helpers/mock-provider.js";

const agent = (memory: AgentConfig["memory"]): AgentConfig => ({ ...simpleAgent, memory });

const registry = (): RunnerMemoryRegistry =>
  new RunnerMemoryRegistry(createMockProvider([]), new EventBus());

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("consolidatorOptions", () => {
  it("copies only the fields that are set, and always the event bus", () => {
    const events = new EventBus();
    expect(consolidatorOptions({ enabled: true }, events)).toEqual({ events });
  });

  it("maps consolidation_model onto model", () => {
    const events = new EventBus();
    const cfg = { enabled: true, every_n_turns: 4, consolidation_model: "m", recent_memory_limit: 7 };
    expect(consolidatorOptions(cfg, events)).toEqual({
      every_n_turns: 4,
      model: "m",
      recent_memory_limit: 7,
      events,
    });
  });
});

describe("RunnerMemoryRegistry.userMemoryFor", () => {
  it("returns undefined when the agent has no user_memory config", () => {
    expect(registry().userMemoryFor(simpleAgent)).toBeUndefined();
  });

  it("builds the store lazily and caches it per agent", () => {
    const r = registry();
    const a = agent({ user_memory: { store: "memory" } });
    const first = r.userMemoryFor(a);
    expect(first?.store).toBeInstanceOf(MemoryUserMemoryStore);
    expect(first?.cfg).toBe(a.memory?.user_memory);
    expect(r.userMemoryFor(a)?.store).toBe(first?.store);
  });

  it("prefers a store injected with setUserMemoryStore", () => {
    const r = registry();
    const injected = new MemoryUserMemoryStore();
    r.setUserMemoryStore(simpleAgent.name, injected);
    expect(r.userMemoryFor(agent({ user_memory: { store: "memory" } }))?.store).toBe(injected);
  });

  it("propagates the factory error for postgres without TUTTI_PG_URL", () => {
    vi.stubEnv("TUTTI_PG_URL", "");
    const a = agent({ user_memory: { store: "postgres" } });
    expect(() => registry().userMemoryFor(a)).toThrow(/TUTTI_PG_URL/);
  });
});

describe("RunnerMemoryRegistry.userModelFor", () => {
  it("returns undefined with no config or when disabled", () => {
    const r = registry();
    expect(r.userModelFor(simpleAgent)).toBeUndefined();
    expect(r.userModelFor(agent({ user_model: { enabled: false } }))).toBeUndefined();
  });

  it("builds the wiring once and caches it", () => {
    const r = registry();
    const a = agent({ user_model: { enabled: true } });
    const wiring = r.userModelFor(a);
    expect(wiring?.store).toBeInstanceOf(InMemoryUserModelStore);
    expect(r.userModelFor(a)).toBe(wiring);
  });

  it("rebuilds against an override set after the wiring was built", () => {
    const r = registry();
    const a = agent({ user_model: { enabled: true } });
    const before = r.userModelFor(a);
    const override = new InMemoryUserModelStore();
    r.setUserModelStore(a.name, override);
    const after = r.userModelFor(a);
    expect(after).not.toBe(before);
    expect(after?.store).toBe(override);
  });

  it("sources the consolidator from the agent's user-memory store when configured", () => {
    const r = registry();
    const spy = vi.spyOn(r, "userMemoryFor");
    r.userModelFor(agent({ user_model: { enabled: true }, user_memory: { store: "memory" } }));
    expect(spy).toHaveReturnedWith(expect.objectContaining({ store: expect.any(MemoryUserMemoryStore) }));
  });

  it("falls back to an ephemeral memory store without user_memory", () => {
    const r = registry();
    const spy = vi.spyOn(r, "userMemoryFor");
    expect(r.userModelFor(agent({ user_model: { enabled: true } }))).toBeDefined();
    expect(spy).toHaveReturnedWith(undefined);
  });
});
