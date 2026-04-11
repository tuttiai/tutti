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
import { PromptGuard } from "./prompt-guard.js";
import { TokenBudget } from "./token-budget.js";

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_MAX_TOOL_CALLS = 20;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

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
      throw new Error(
        `Session not found: ${session_id}\n` +
        `The session may have expired or the ID is incorrect.\n` +
        `Omit session_id to start a new conversation.`,
      );
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
    const budget = agent.budget
      ? new TokenBudget(agent.budget, agent.model ?? "")
      : undefined;
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

      // Check token budget
      if (budget) {
        budget.add(response.usage.input_tokens, response.usage.output_tokens);
        const status = budget.check();
        if (status === "warning") {
          this.events.emit({
            type: "budget:warning",
            agent_name: agent.name,
            tokens: budget.total_tokens,
            cost_usd: budget.estimated_cost_usd,
          });
        } else if (status === "exceeded") {
          this.events.emit({
            type: "budget:exceeded",
            agent_name: agent.name,
            tokens: budget.total_tokens,
            cost_usd: budget.estimated_cost_usd,
          });
          messages.push({ role: "assistant", content: response.content });
          break;
        }
      }

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

      const toolTimeoutMs = agent.tool_timeout_ms ?? DEFAULT_TOOL_TIMEOUT_MS;
      const toolResults: ToolResultBlock[] = await Promise.all(
        toolUseBlocks.map((block) =>
          this.executeTool(allTools, block, {
            session_id: session.id,
            agent_name: agent.name,
          }, toolTimeoutMs),
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

  private async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    toolName: string,
  ): Promise<T> {
    return Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Tool "${toolName}" timed out after ${timeoutMs}ms.\n` +
                `Increase tool_timeout_ms in your agent config, or check if the tool is hanging.`,
              ),
            ),
          timeoutMs,
        ),
      ),
    ]);
  }

  private async executeTool(
    tools: Tool[],
    block: ToolUseBlock,
    context: ToolContext,
    timeoutMs: number,
  ): Promise<ToolResultBlock> {
    const tool = tools.find((t) => t.name === block.name);
    if (!tool) {
      const available = tools.map((t) => t.name).join(", ") || "(none)";
      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: `Tool "${block.name}" not found. Available tools: ${available}`,
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
      const result = await this.executeWithTimeout(
        () => tool.execute(parsed, context),
        timeoutMs,
        block.name,
      );

      this.events.emit({
        type: "tool:end",
        agent_name: context.agent_name,
        tool_name: block.name,
        result,
      });

      // Scan for prompt injection and wrap content
      const scan = PromptGuard.scan(result.content);
      if (!scan.safe) {
        this.events.emit({
          type: "security:injection_detected",
          agent_name: context.agent_name,
          tool_name: block.name,
          patterns: scan.found,
        });
      }

      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: PromptGuard.wrap(block.name, result.content),
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
