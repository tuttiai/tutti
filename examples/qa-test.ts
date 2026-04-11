import { AgentRouter, AnthropicProvider, defineScore } from "@tuttiai/core";
import { PlaywrightVoice } from "@tuttiai/playwright";

const playwrightVoice = new PlaywrightVoice({ headless: true });

const score = defineScore({
  provider: new AnthropicProvider(),
  default_model: "claude-sonnet-4-20250514",
  entry: "orchestrator",
  agents: {
    orchestrator: {
      name: "Tutti Orchestrator",
      role: "orchestrator",
      system_prompt: `You are the Tutti orchestrator. Delegate browser testing tasks to the QA agent.`,
      voices: [],
      delegates: ["qa"],
    },
    qa: {
      name: "QA Agent",
      role: "specialist",
      system_prompt: `You are a thorough QA engineer with browser control. Test web applications like a real user would. Take screenshots to document your findings. Report bugs clearly with steps to reproduce.`,
      voices: [playwrightVoice],
      permissions: ["network", "browser"],
    },
  },
});

const router = new AgentRouter(score);

router.events.on("tool:start", (e) => {
  if (e.tool_name !== "delegate_to_agent") {
    console.log(`[tool] ${e.tool_name}`);
  }
});
router.events.on("tool:end", (e) => {
  if (e.tool_name !== "delegate_to_agent") {
    console.log(`[tool] ${e.tool_name} done`);
  }
});
router.events.on("delegate:start", (e) => {
  console.log(`\n[delegation] ${e.from} → ${e.to}`);
});
router.events.on("delegate:end", (e) => {
  console.log(`[delegation] ${e.to} finished (${e.output.length} chars)`);
});

console.log("Running QA test on example.com...\n");

const result = await router.run(
  `Test the example.com website:
   1. Navigate to https://example.com
   2. Take a screenshot and save it as example-screenshot.png
   3. Get the page title and main heading
   4. Check if there is a link on the page and get its href
   5. Write a brief QA report of what you found`,
);

console.log("\n--- QA Report ---");
console.log(result.output);
console.log(`\nTurns: ${result.turns}`);
console.log(
  `Tokens: ${result.usage.input_tokens + result.usage.output_tokens}`,
);

// Clean up browser
await playwrightVoice.teardown();
