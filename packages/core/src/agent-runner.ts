import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  AgentConfig,
  AgentResult,
  ChatMessage,
  ContentBlock,
  LLMProvider,
  SessionStore,
  Tool,
  ToolContext,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
  TokenUsage,
} from "@tuttiai/types";
import type { EventBus } from "./event-bus.js";
import { SecretsManager } from "./secrets.js";

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_MAX_TOOL_CALLS = 20;

export class AgentRunner {
  constructor(
    private provider: LLMProvider,
    private events: EventBus,
    private sessions: SessionStore,
  ) {}

  async run(
    agent: AgentConfig,
    input: string,
    session_id?: string,
  ): Promise<AgentResult> {
    // Resolve or create session
    const session = session_id
      ? this.sessions.get(session_id)
      : this.sessions.create(agent.name);

    if (!session) {
      throw new Error(`Session not found: ${session_id}`);
    }

    this.events.emit({
      type: "agent:start",
      agent_name: agent.name,
      session_id: session.id,
    });

    // Collect all tools from all voices
    const allTools = agent.voices.flatMap((v) => v.tools);
    const toolDefs = allTools.map(toolToDefinition);

    // Add user message
    const messages: ChatMessage[] = [
      ...session.messages,
      { role: "user", content: input },
    ];

    const maxTurns = agent.max_turns ?? DEFAULT_MAX_TURNS;
    const maxToolCalls = agent.max_tool_calls ?? DEFAULT_MAX_TOOL_CALLS;
    const totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
    let turns = 0;
    let totalToolCalls = 0;

    // Agentic loop
    while (turns < maxTurns) {
      turns++;

      this.events.emit({
        type: "turn:start",
        agent_name: agent.name,
        session_id: session.id,
        turn: turns,
      });

      const request = {
        model: agent.model,
        system: agent.system_prompt,
        messages,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
      };

      this.events.emit({
        type: "llm:request",
        agent_name: agent.name,
        request,
      });

      const response = await this.provider.chat(request);

      this.events.emit({
        type: "llm:response",
        agent_name: agent.name,
        response,
      });

      totalUsage.input_tokens += response.usage.input_tokens;
      totalUsage.output_tokens += response.usage.output_tokens;

      // Add assistant message
      messages.push({ role: "assistant", content: response.content });

      this.events.emit({
        type: "turn:end",
        agent_name: agent.name,
        session_id: session.id,
        turn: turns,
      });

      // If the model is done talking, exit the loop
      if (response.stop_reason !== "tool_use") {
        break;
      }

      // Execute tool calls
      const toolUseBlocks = response.content.filter(
        (b): b is ToolUseBlock => b.type === "tool_use",
      );

      totalToolCalls += toolUseBlocks.length;
      if (totalToolCalls > maxToolCalls) {
        messages.push({
          role: "user",
          content: toolUseBlocks.map((block) => ({
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: `Tool call rate limit exceeded: ${totalToolCalls} calls (max: ${maxToolCalls})`,
            is_error: true,
          })),
        });
        break;
      }

      const toolResults: ToolResultBlock[] = await Promise.all(
        toolUseBlocks.map((block) =>
          this.executeTool(allTools, block, {
            session_id: session.id,
            agent_name: agent.name,
          }),
        ),
      );

      // Add tool results as a user message (Anthropic API format)
      messages.push({ role: "user", content: toolResults });
    }

    // Persist updated messages
    this.sessions.update(session.id, messages);

    // Extract final text output
    const lastAssistant = messages
      .filter((m) => m.role === "assistant")
      .at(-1);

    const output = extractText(lastAssistant?.content);

    this.events.emit({
      type: "agent:end",
      agent_name: agent.name,
      session_id: session.id,
    });

    return {
      session_id: session.id,
      output,
      messages,
      turns,
      usage: totalUsage,
    };
  }

  private async executeTool(
    tools: Tool[],
    block: ToolUseBlock,
    context: ToolContext,
  ): Promise<ToolResultBlock> {
    const tool = tools.find((t) => t.name === block.name);
    if (!tool) {
      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: `Tool not found: ${block.name}`,
        is_error: true,
      };
    }

    this.events.emit({
      type: "tool:start",
      agent_name: context.agent_name,
      tool_name: block.name,
      input: block.input,
    });

    try {
      // Validate input with Zod
      const parsed = tool.parameters.parse(block.input);
      const result = await tool.execute(parsed, context);

      this.events.emit({
        type: "tool:end",
        agent_name: context.agent_name,
        tool_name: block.name,
        result,
      });

      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: result.content,
        is_error: result.is_error,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.events.emit({
        type: "tool:error",
        agent_name: context.agent_name,
        tool_name: block.name,
        error: error instanceof Error ? error : new Error(message),
      });

      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: SecretsManager.redact(`Tool execution error: ${message}`),
        is_error: true,
      };
    }
  }
}

function toolToDefinition(tool: Tool): ToolDefinition {
  const jsonSchema = zodToJsonSchema(tool.parameters, { target: "openApi3" });
  return {
    name: tool.name,
    description: tool.description,
    input_schema: jsonSchema as Record<string, unknown>,
  };
}

function extractText(content: string | ContentBlock[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n");
}
