import { TuttiRuntime, AnthropicProvider, defineScore, createLogger } from "@tuttiai/core";
import { McpVoice } from "@tuttiai/mcp";

const logger = createLogger("mcp-example");

// Wrap any MCP server as a Tutti voice
const mcpVoice = new McpVoice({
  server: "npx @playwright/mcp",
  name: "playwright-mcp",
});

const score = defineScore({
  name: "mcp-example",
  provider: new AnthropicProvider(),
  agents: {
    browser: {
      name: "browser-agent",
      model: "claude-sonnet-4-20250514",
      system_prompt: "You are a browser automation agent. Use the available tools to navigate the web.",
      voices: [mcpVoice],
      permissions: ["network"],
      streaming: true,
    },
  },
});

const tutti = new TuttiRuntime(score);

tutti.events.on("token:stream", (e) => {
  process.stdout.write(e.text);
});

logger.info("Starting MCP bridge agent — tools will be discovered from the MCP server...");

const result = await tutti.run(
  "browser",
  "Navigate to https://example.com and tell me the page title.",
);

console.log();
logger.info({ output: result.output, turns: result.turns }, "Result");
