/**
 * Curated semantic memory across two turns.
 *
 * Turn 1 — the user shares a preference. The agent's `remember` tool
 * tags it with `source: "agent"` and stores it in the runtime's
 * shared `SemanticMemoryStore`.
 *
 * Turn 2 — a fresh session for the same agent. The runtime's startup
 * `recall` injects relevant entries into the system prompt, so the
 * model already knows the preference and can act on it without being
 * reminded.
 *
 * Run with `tsx examples/curated-memory.ts` after exporting your
 * provider key.
 */

import {
  AnthropicProvider,
  TuttiRuntime,
  createLogger,
  defineScore,
} from "@tuttiai/core";

const logger = createLogger("curated-memory-example");

const score = defineScore({
  name: "curated-memory",
  provider: new AnthropicProvider(),
  agents: {
    assistant: {
      name: "assistant",
      model: "claude-sonnet-4-20250514",
      system_prompt:
        "You are a friendly assistant. When the user shares a preference or " +
        "fact about themselves, store it with the `remember` tool so future " +
        "sessions remain consistent.",
      voices: [],
      memory: {
        semantic: {
          enabled: true,
          // Both surfaces active: system-prompt injection AND
          // agent-callable tools.
          inject_system: true,
          curated_tools: true,
          max_entries_per_agent: 200,
        },
      },
    },
  },
});

const tutti = new TuttiRuntime(score);

tutti.events.on("memory:write", (e) => {
  logger.info(
    { source: e.source, tags: e.tags, entry_id: e.entry_id },
    "memory:write",
  );
});
tutti.events.on("memory:read", (e) => {
  logger.info({ query: e.query, hits: e.result_count }, "memory:read");
});

const turn1 = await tutti.run(
  "assistant",
  "Hi! I prefer 2-space indentation in TypeScript and dislike trailing commas. " +
    "Please remember that for future sessions.",
);
logger.info({ session: turn1.session_id, output: turn1.output }, "Turn 1");

// Fresh session — no shared message history. The runtime's
// system-prompt injection surfaces the remembered preference at the
// start of the new run.
const turn2 = await tutti.run(
  "assistant",
  "Show me a tiny TypeScript snippet that prints 'hello'.",
);
logger.info({ session: turn2.session_id, output: turn2.output }, "Turn 2");
