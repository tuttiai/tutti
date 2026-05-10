/**
 * Dialectic user model — a 25-turn end-to-end demonstration.
 *
 * This example shows the runtime building up a {@link UserProfile} for
 * one end user across many runs:
 *
 * 1. Each run starts with a `user_id` set, so the runtime injects the
 *    current profile (initially absent) into the system prompt.
 * 2. After each run, the consolidator's turn counter advances. When it
 *    crosses `every_n_turns` (5 here, for fast feedback), a mock LLM
 *    consolidation pass writes a fresh `UserProfile` based on the
 *    user-memory entries we seed throughout the conversation.
 * 3. At the end we print the final profile so you can see the
 *    accumulated `summary`, `preferences`, and `ongoing_projects`.
 *
 * The example uses a mock LLM provider so it runs offline with no API
 * key. Run with: `tsx examples/user-model/tutti.score.ts`.
 */

import { setTimeout as wait } from "node:timers/promises";

import {
  AgentRunner,
  EventBus,
  InMemorySessionStore,
  InMemoryUserModelStore,
  MemoryUserMemoryStore,
  createLogger,
} from "@tuttiai/core";
import type {
  AgentConfig,
  ChatRequest,
  ChatResponse,
  LLMProvider,
  StreamChunk,
} from "@tuttiai/types";

const logger = createLogger("user-model-example");
const USER_ID = "user-alex";

/**
 * Mock LLM provider that distinguishes consolidation calls (their
 * system prompt starts with "You maintain a profile of an end-user")
 * from normal agent calls. Consolidation calls return a JSON profile
 * derived from the conversation so far; regular agent turns return a
 * short canned reply.
 */
function mockProvider(): LLMProvider {
  // What the agent has "learned" about the user so far. The
  // consolidation pass projects this into the JSON profile.
  const learned = {
    summary: "",
    preferences: {} as Record<string, string>,
    ongoing_projects: [] as string[],
  };

  return {
    async chat(request: ChatRequest): Promise<ChatResponse> {
      if (typeof request.system === "string"
        && request.system.startsWith("You maintain a profile")) {
        return {
          id: "cons-" + Math.random().toString(36).slice(2),
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: learned.summary,
                preferences: learned.preferences,
                ongoing_projects: learned.ongoing_projects,
              }),
            },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 200, output_tokens: 80 },
        };
      }

      // Normal agent reply.
      const lastUser = request.messages[request.messages.length - 1];
      const userText =
        typeof lastUser?.content === "string"
          ? lastUser.content
          : "(complex)";

      // Side-channel — pretend the agent extracted a fact from the
      // user's message. In a real deployment this happens via
      // `auto_infer` or explicit `remember` tool calls.
      ingestFact(learned, userText);

      return {
        id: "reply-" + Math.random().toString(36).slice(2),
        content: [{ type: "text", text: "Got it." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 10 },
      };
    },
    // eslint-disable-next-line @typescript-eslint/require-yield -- not exercised
    async *stream(): AsyncIterable<StreamChunk> {
      throw new Error("stream not implemented in this example");
    },
  };
}

/**
 * Tiny rule-based "extractor" so the mock profile evolves as the
 * conversation progresses. The shape of what we project into the
 * eventual `UserProfile` reflects the shape of the inputs.
 */
function ingestFact(
  learned: { summary: string; preferences: Record<string, string>; ongoing_projects: string[] },
  text: string,
): void {
  const lower = text.toLowerCase();
  if (lower.includes("typescript")) learned.preferences.language = "typescript";
  if (lower.includes("terse") || lower.includes("short answers")) {
    learned.preferences.communication_style = "terse, no emojis";
  }
  if (lower.includes("payments-api")) {
    if (!learned.ongoing_projects.includes("payments-api")) {
      learned.ongoing_projects.push("payments-api");
    }
  }
  if (lower.includes("checkout migration")) {
    if (!learned.ongoing_projects.includes("checkout-migration")) {
      learned.ongoing_projects.push("checkout-migration");
    }
  }
  if (lower.includes("alex")) {
    learned.summary =
      "Alex — backend engineer. Prefers strongly-typed languages, " +
      "terse responses, and direct, no-emoji communication.";
  }
}

const agent: AgentConfig = {
  name: "assistant",
  model: "mock-model",
  system_prompt:
    "You are a friendly assistant who adapts to the user's communication style.",
  voices: [],
  memory: {
    user_memory: { store: "memory", inject_limit: 5 },
    user_model: {
      enabled: true,
      // Keep the example fast — consolidate every 5 turns so we get
      // multiple passes inside a 25-turn conversation.
      every_n_turns: 5,
      recent_memory_limit: 50,
    },
  },
};

const turns = [
  "Hi, I'm Alex.",
  "I work mainly in TypeScript.",
  "I prefer short answers — terse is better.",
  "I'm currently leading the payments-api rewrite.",
  "Also juggling a checkout-migration on the side.",
  "What's the best way to model idempotent retries?",
  "Got it — let's apply that to payments-api.",
  "By the way, I never use emojis in code reviews.",
  "Can you remind me what I said about TypeScript?",
  "Yes, that's still my preference.",
  "On the checkout-migration: any thoughts on flag rollout?",
  "Quick question: what is exactly-once delivery?",
  "OK that lines up with what I expected.",
  "Back to terse mode please.",
  "Do you remember what projects I'm on?",
  "Right — payments-api and checkout-migration.",
  "I want to draft an RFC for the payments-api retries.",
  "Keep responses to one sentence each from here on.",
  "Alex's RFC will live in our internal docs repo.",
  "Tell me a one-line summary of the checkout-migration risks.",
  "Good. I'll loop the team in tomorrow.",
  "Shorter please.",
  "Even shorter.",
  "OK — what's the status of my profile?",
  "Last question for now.",
];

async function main(): Promise<void> {
  const provider = mockProvider();
  const events = new EventBus();
  events.on("user_model:consolidated", (e) => {
    logger.info(
      { user_id: e.user_id, turn_count: e.turn_count },
      "User model consolidated",
    );
  });

  const runner = new AgentRunner(provider, events, new InMemorySessionStore());
  const memoryStore = new MemoryUserMemoryStore();
  const modelStore = new InMemoryUserModelStore();
  runner.setUserMemoryStore(agent.name, memoryStore);
  runner.setUserModelStore(agent.name, modelStore);

  // Seed a few user-memory entries so the consolidator has source
  // signal on its first pass.
  await memoryStore.store(USER_ID, "User name is Alex", { importance: 3 });
  await memoryStore.store(USER_ID, "User prefers TypeScript", { importance: 3 });
  await memoryStore.store(USER_ID, "User prefers terse responses", { importance: 3 });
  await memoryStore.store(USER_ID, "User leads payments-api project", { importance: 2 });
  await memoryStore.store(USER_ID, "User works on checkout-migration", { importance: 2 });

  let sessionId: string | undefined;

  for (let i = 0; i < turns.length; i++) {
    const input = turns[i]!;
    const result = await runner.run(agent.name === undefined ? agent : agent, input, sessionId, {
      user_id: USER_ID,
    });
    sessionId = result.session_id;
    logger.info({ turn: i + 1, input, reply: result.output }, "turn done");
    // Yield so the fire-and-forget consolidator promise can settle
    // before the next run reads the profile.
    await wait(0);
  }

  // Give any trailing consolidation pass a moment to finish.
  await wait(20);

  const finalProfile = await modelStore.get(USER_ID);
  logger.info({ profile: finalProfile }, "Final user profile");
  // eslint-disable-next-line no-console -- example output
  console.log("\n=== FINAL USER PROFILE ===");
  // eslint-disable-next-line no-console -- example output
  console.log(JSON.stringify(finalProfile, null, 2));
}

main().catch((err) => {
  logger.error(
    { error: err instanceof Error ? err.message : String(err) },
    "example failed",
  );
  process.exitCode = 1;
});
