import { AgentRouter, AnthropicProvider, defineScore } from "@tuttiai/core";
import { FilesystemVoice } from "@tuttiai/filesystem";

const score = defineScore({
  provider: new AnthropicProvider(),
  default_model: "claude-sonnet-4-20250514",
  entry: "orchestrator",
  agents: {
    orchestrator: {
      name: "Tutti Orchestrator",
      role: "orchestrator",
      system_prompt: `You are the Tutti orchestrator. You receive user requests and delegate them to the right specialist agent.

Always think about which specialist is best suited before delegating. Be concise when summarizing results back to the user.`,
      voices: [],
      delegates: ["coder", "pm", "qa"],
    },
    coder: {
      name: "Coding Agent",
      role: "specialist",
      system_prompt: `You are an expert TypeScript developer. You write clean, well-tested, production-ready code. You have access to the filesystem to read and write files.`,
      voices: [new FilesystemVoice()],
    },
    pm: {
      name: "Product Manager Agent",
      role: "specialist",
      system_prompt: `You are a senior product manager. You write clear specs, break down features into tasks, and think about user experience and business impact.`,
      voices: [],
    },
    qa: {
      name: "QA Agent",
      role: "specialist",
      system_prompt: `You are a thorough QA engineer. You think about edge cases, write test plans, and identify potential bugs before they reach production.`,
      voices: [],
    },
  },
});

const router = new AgentRouter(score);

// Log delegation events
router.events.on("agent:start", (e) => {
  console.log(`\n[${e.agent_name}] starting...`);
});
router.events.on("delegate:start", (e) => {
  console.log(`[delegation] ${e.from} → ${e.to}: "${e.task}"`);
});
router.events.on("delegate:end", (e) => {
  console.log(`[delegation] ${e.to} finished (${e.output.length} chars)`);
});
router.events.on("tool:start", (e) => {
  if (e.tool_name !== "delegate_to_agent") {
    console.log(`[tool] ${e.tool_name}`);
  }
});

// Test three different inputs that should route to different agents
const inputs = [
  "Write a TypeScript function that reverses a string and save it to reverse.ts",
  "Write a one-paragraph product spec for a dark mode toggle feature",
  "Write a test plan for a user login form",
];

for (const input of inputs) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`INPUT: ${input}`);
  console.log("=".repeat(60));

  const result = await router.run(input);
  console.log(`\nOUTPUT:\n${result.output}`);
  console.log(
    `\nTurns: ${result.turns} | Tokens: ${result.usage.input_tokens + result.usage.output_tokens}`,
  );
}
