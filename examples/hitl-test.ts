import { createInterface } from "node:readline/promises";
import { TuttiRuntime, AnthropicProvider, defineScore, createLogger } from "@tuttiai/core";

const logger = createLogger("hitl-example");

const score = defineScore({
  name: "hitl-example",
  provider: new AnthropicProvider(),
  agents: {
    coder: {
      name: "coder",
      model: "claude-sonnet-4-20250514",
      system_prompt:
        "You are a cautious coding assistant. Before writing or modifying any file, " +
        "use the request_human_input tool to ask the user for permission. " +
        "Always describe what you plan to do and wait for approval.",
      voices: [],
      allow_human_input: true,
      streaming: true,
    },
  },
});

const tutti = new TuttiRuntime(score);

const rl = createInterface({ input: process.stdin, output: process.stdout });

// Stream tokens
tutti.events.on("token:stream", (e) => {
  process.stdout.write(e.text);
});

// Handle HITL requests
tutti.events.on("hitl:requested", async (e) => {
  console.log("\n");
  console.log("  [Agent needs input] " + e.question);
  if (e.options) {
    e.options.forEach((opt, i) => console.log("    " + (i + 1) + ". " + opt));
  }
  const answer = await rl.question("  > ");
  tutti.answer(e.session_id, answer.trim());
});

logger.info("Running coder agent with human-in-the-loop...");

const result = await tutti.run("coder", "Create a hello.ts file that prints hello world");

console.log();
logger.info({ output: result.output, turns: result.turns }, "Done");

rl.close();
