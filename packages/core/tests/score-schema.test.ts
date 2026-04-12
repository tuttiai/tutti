import { describe, it, expect } from "vitest";
import { validateScore } from "../src/score-schema.js";

/** Minimal valid score object (provider is a duck-typed object with chat()). */
function validScore(overrides?: Record<string, unknown>) {
  return {
    provider: { chat: async () => ({}) },
    agents: {
      assistant: {
        name: "assistant",
        system_prompt: "You are helpful.",
        voices: [],
      },
    },
    ...overrides,
  };
}

describe("validateScore", () => {
  // ── Happy path ──

  it("accepts a valid minimal score", () => {
    expect(() => validateScore(validScore())).not.toThrow();
  });

  it("accepts a score with all optional fields", () => {
    expect(() =>
      validateScore(
        validScore({
          name: "test",
          description: "A test score",
          default_model: "claude-sonnet-4-20250514",
          entry: "assistant",
        }),
      ),
    ).not.toThrow();
  });

  it("accepts agents with budget, permissions, and limits", () => {
    expect(() =>
      validateScore({
        provider: { chat: async () => ({}) },
        agents: {
          bot: {
            name: "bot",
            system_prompt: "hi",
            voices: [],
            permissions: ["filesystem", "network"],
            max_turns: 5,
            max_tool_calls: 10,
            tool_timeout_ms: 5000,
            budget: { max_tokens: 1000, max_cost_usd: 0.5, warn_at_percent: 90 },
            delegates: [],
            role: "specialist",
          },
        },
      }),
    ).not.toThrow();
  });

  // ── Missing provider ──

  it("throws if provider is missing", () => {
    expect(() =>
      validateScore({
        agents: {
          a: { name: "a", system_prompt: "p", voices: [] },
        },
      }),
    ).toThrow("provider");
  });

  it("throws if provider has no chat method", () => {
    expect(() =>
      validateScore({
        provider: { notChat: true },
        agents: {
          a: { name: "a", system_prompt: "p", voices: [] },
        },
      }),
    ).toThrow("provider");
  });

  // ── Agent validation ──

  it("throws if agents object is empty", () => {
    expect(() =>
      validateScore({ provider: { chat: async () => ({}) }, agents: {} }),
    ).toThrow("at least one agent");
  });

  it("throws if agent name is empty", () => {
    expect(() =>
      validateScore({
        provider: { chat: async () => ({}) },
        agents: {
          a: { name: "", system_prompt: "p", voices: [] },
        },
      }),
    ).toThrow("Agent name cannot be empty");
  });

  it("throws if system_prompt is empty", () => {
    expect(() =>
      validateScore({
        provider: { chat: async () => ({}) },
        agents: {
          a: { name: "a", system_prompt: "", voices: [] },
        },
      }),
    ).toThrow("system_prompt cannot be empty");
  });

  it("throws if max_turns is negative", () => {
    expect(() =>
      validateScore({
        provider: { chat: async () => ({}) },
        agents: {
          a: { name: "a", system_prompt: "p", voices: [], max_turns: -1 },
        },
      }),
    ).toThrow("max_turns must be a positive number");
  });

  it("throws if max_tool_calls is zero", () => {
    expect(() =>
      validateScore({
        provider: { chat: async () => ({}) },
        agents: {
          a: { name: "a", system_prompt: "p", voices: [], max_tool_calls: 0 },
        },
      }),
    ).toThrow("max_tool_calls must be a positive number");
  });

  it("throws if tool_timeout_ms is negative", () => {
    expect(() =>
      validateScore({
        provider: { chat: async () => ({}) },
        agents: {
          a: {
            name: "a",
            system_prompt: "p",
            voices: [],
            tool_timeout_ms: -100,
          },
        },
      }),
    ).toThrow("tool_timeout_ms must be a positive number");
  });

  // ── Permission validation ──

  it("throws for invalid permission values", () => {
    expect(() =>
      validateScore({
        provider: { chat: async () => ({}) },
        agents: {
          a: {
            name: "a",
            system_prompt: "p",
            voices: [],
            permissions: ["nuclear"],
          },
        },
      }),
    ).toThrow("Invalid score file");
  });

  // ── Voice validation ──

  it("throws if a voice has an empty name", () => {
    expect(() =>
      validateScore({
        provider: { chat: async () => ({}) },
        agents: {
          a: {
            name: "a",
            system_prompt: "p",
            voices: [{ name: "", tools: [], required_permissions: [] }],
          },
        },
      }),
    ).toThrow("Voice name cannot be empty");
  });

  // ── Cross-field: delegates ──

  it("throws if a delegate references a nonexistent agent", () => {
    expect(() =>
      validateScore({
        provider: { chat: async () => ({}) },
        agents: {
          orch: {
            name: "orch",
            system_prompt: "p",
            voices: [],
            delegates: ["ghost"],
          },
        },
      }),
    ).toThrow('references unknown agent "ghost"');
  });

  it("includes available agents in delegate error", () => {
    expect(() =>
      validateScore({
        provider: { chat: async () => ({}) },
        agents: {
          orch: {
            name: "orch",
            system_prompt: "p",
            voices: [],
            delegates: ["missing"],
          },
          coder: {
            name: "coder",
            system_prompt: "p",
            voices: [],
          },
        },
      }),
    ).toThrow("Available: orch, coder");
  });

  // ── Cross-field: entry ──

  it("throws if entry references a nonexistent agent", () => {
    expect(() =>
      validateScore({
        ...validScore(),
        entry: "nonexistent",
      }),
    ).toThrow('references unknown agent "nonexistent"');
  });

  it("accepts entry that references an existing agent", () => {
    expect(() =>
      validateScore({
        ...validScore(),
        entry: "assistant",
      }),
    ).not.toThrow();
  });

  // ── Streaming field ──

  it("accepts streaming: true on an agent", () => {
    expect(() =>
      validateScore({
        provider: { chat: async () => ({}) },
        agents: {
          a: { name: "a", system_prompt: "p", voices: [], streaming: true },
        },
      }),
    ).not.toThrow();
  });

  it("accepts streaming: false on an agent", () => {
    expect(() =>
      validateScore({
        provider: { chat: async () => ({}) },
        agents: {
          a: { name: "a", system_prompt: "p", voices: [], streaming: false },
        },
      }),
    ).not.toThrow();
  });

  // ── Telemetry config ──

  it("accepts a valid telemetry config", () => {
    expect(() =>
      validateScore({
        ...validScore(),
        telemetry: { enabled: true, endpoint: "http://localhost:4318" },
      }),
    ).not.toThrow();
  });

  it("accepts telemetry with headers", () => {
    expect(() =>
      validateScore({
        ...validScore(),
        telemetry: {
          enabled: true,
          endpoint: "https://otel.example.com",
          headers: { Authorization: "Bearer token" },
        },
      }),
    ).not.toThrow();
  });

  it("accepts telemetry: { enabled: false }", () => {
    expect(() =>
      validateScore({
        ...validScore(),
        telemetry: { enabled: false },
      }),
    ).not.toThrow();
  });

  it("throws if telemetry.endpoint is not a valid URL", () => {
    expect(() =>
      validateScore({
        ...validScore(),
        telemetry: { enabled: true, endpoint: "not-a-url" },
      }),
    ).toThrow("telemetry.endpoint must be a valid URL");
  });

  it("throws if telemetry has unknown fields (strict)", () => {
    expect(() =>
      validateScore({
        ...validScore(),
        telemetry: { enabled: true, foo: "bar" },
      }),
    ).toThrow("Invalid score file");
  });
});
