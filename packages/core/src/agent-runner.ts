import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  AgentConfig,
  AgentResult,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ContentBlock,
  LLMProvider,
  SessionStore,
  StopReason,
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
import type { SemanticMemoryStore } from "./memory/semantic.js";
import { logger } from "./logger.js";
import { TuttiTracer } from "./telemetry.js";
import { ToolTimeoutError, ProviderError, RateLimitError } from "./errors.js";

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_MAX_TOOL_CALLS = 20;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_RETRIES = 3;

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= MAX_PROVIDER_RETRIES || !(err instanceof ProviderError)) {
        throw err;
      }
      if (err instanceof RateLimitError && err.retryAfter) {
        logger.warn({ attempt, retryAfter: err.retryAfter }, "Rate limited, waiting before retry");
        await new Promise((r) => setTimeout(r, err.retryAfter! * 1000));
      } else {
        const delayMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
        logger.warn({ attempt, delayMs }, "Provider error, retrying with backoff");
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
}

export class AgentRunner {
  constructor(
    private provider: LLMProvider,
    private events: EventBus,
    private sessions: SessionStore,
    private semanticMemory?: SemanticMemoryStore,
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

    return TuttiTracer.agentRun(agent.name, session.id, async () => {
      logger.info({ agent: agent.name, session: session.id }, "Agent started");

      this.events.emit({
        type: "agent:start",
        agent_name: agent.name,
        session_id: session.id,
      });

      // Initialize voices that have setup hooks (e.g., MCP voice discovers tools)
      const voiceCtx = { session_id: session.id, agent_name: agent.name };
      for (const voice of agent.voices) {
        if (voice.setup) {
          await voice.setup(voiceCtx);
        }
      }

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

        logger.info({ agent: agent.name, session: session.id, turn: turns }, "Turn started");

        this.events.emit({
          type: "turn:start",
          agent_name: agent.name,
          session_id: session.id,
          turn: turns,
        });

        // Inject semantic memories into system prompt if enabled
        let systemPrompt = agent.system_prompt;
        const memCfg = agent.semantic_memory;
        if (memCfg?.enabled && this.semanticMemory) {
          const maxMemories = memCfg.max_memories ?? 5;
          const injectSystem = memCfg.inject_system !== false;
          if (injectSystem) {
            const memories = await this.semanticMemory.search(
              input,
              agent.name,
              maxMemories,
            );
            if (memories.length > 0) {
              const memoryBlock = memories
                .map((m) => `- ${m.content}`)
                .join("\n");
              systemPrompt +=
                "\n\nRelevant context from previous sessions:\n" +
                memoryBlock;
            }
          }
        }

        const request = {
          model: agent.model,
          system: systemPrompt,
          messages,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
        };

        logger.debug({ agent: agent.name, model: agent.model }, "LLM request");

        this.events.emit({
          type: "llm:request",
          agent_name: agent.name,
          request,
        });

        const response = await TuttiTracer.llmCall(
          agent.model ?? "unknown",
          () => withRetry(() =>
            agent.streaming
              ? this.streamToResponse(agent.name, request)
              : this.provider.chat(request),
          ),
        );

        logger.debug(
          { agent: agent.name, stopReason: response.stop_reason, usage: response.usage },
          "LLM response",
        );

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
            logger.warn(
              { agent: agent.name, tokens: budget.total_tokens, cost_usd: budget.estimated_cost_usd },
              "Approaching token budget limit",
            );
            this.events.emit({
              type: "budget:warning",
              agent_name: agent.name,
              tokens: budget.total_tokens,
              cost_usd: budget.estimated_cost_usd,
            });
          } else if (status === "exceeded") {
            logger.warn(
              { agent: agent.name, tokens: budget.total_tokens, cost_usd: budget.estimated_cost_usd },
              "Token budget exceeded",
            );
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
        const toolContext: ToolContext = {
          session_id: session.id,
          agent_name: agent.name,
        };

        // Attach memory helpers if semantic memory is enabled
        if (memCfg?.enabled && this.semanticMemory) {
          const sm = this.semanticMemory;
          const agentName = agent.name;
          toolContext.memory = {
            remember: async (content, metadata = {}) => {
              await sm.add({ agent_name: agentName, content, metadata });
            },
            recall: async (query, limit) => {
              const entries = await sm.search(query, agentName, limit);
              return entries.map((e) => ({ id: e.id, content: e.content }));
            },
            forget: async (id) => {
              await sm.delete(id);
            },
          };
        }

        const toolResults: ToolResultBlock[] = await Promise.all(
          toolUseBlocks.map((block) =>
            this.executeTool(allTools, block, toolContext, toolTimeoutMs),
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

      logger.info(
        { agent: agent.name, session: session.id, turns, usage: totalUsage },
        "Agent finished",
      );

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
    });
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
          () => reject(new ToolTimeoutError(toolName, timeoutMs)),
          timeoutMs,
        ),
      ),
    ]);
  }

  private async streamToResponse(
    agentName: string,
    request: ChatRequest,
  ): Promise<ChatResponse> {
    const content: ContentBlock[] = [];
    let textBuffer = "";
    let usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
    let stopReason: StopReason = "end_turn";

    for await (const chunk of this.provider.stream(request)) {
      if (chunk.type === "text" && chunk.text) {
        textBuffer += chunk.text;
        this.events.emit({
          type: "token:stream",
          agent_name: agentName,
          text: chunk.text,
        });
      }
      if (chunk.type === "tool_use" && chunk.tool) {
        content.push({
          type: "tool_use",
          id: chunk.tool.id,
          name: chunk.tool.name,
          input: chunk.tool.input,
        });
      }
      if (chunk.type === "usage") {
        if (chunk.usage) usage = chunk.usage;
        if (chunk.stop_reason) stopReason = chunk.stop_reason;
      }
    }

    if (textBuffer) {
      content.unshift({ type: "text", text: textBuffer });
    }

    return { id: "", content, stop_reason: stopReason, usage };
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

    return TuttiTracer.toolCall(block.name, async () => {
      logger.debug({ tool: block.name, input: block.input }, "Tool called");

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

        logger.debug({ tool: block.name, result: result.content }, "Tool completed");

        this.events.emit({
          type: "tool:end",
          agent_name: context.agent_name,
          tool_name: block.name,
          result,
        });

        // Scan for prompt injection and wrap content
        const scan = PromptGuard.scan(result.content);
        if (!scan.safe) {
          logger.warn(
            { tool: block.name, patterns: scan.found },
            "Potential prompt injection detected in tool output",
          );
          this.events.emit({
            type: "security:injection_detected",
            agent_name: context.agent_name,
            tool_name: block.name,
            patterns: scan.found,
          });
        }

        return {
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: PromptGuard.wrap(block.name, result.content),
          is_error: result.is_error,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        logger.error({ error: message, tool: block.name }, "Tool failed");

        this.events.emit({
          type: "tool:error",
          agent_name: context.agent_name,
          tool_name: block.name,
          error: error instanceof Error ? error : new Error(message),
        });

        return {
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: SecretsManager.redact(`Tool execution error: ${message}`),
          is_error: true,
        };
      }
    });
  }
}

function toolToDefinition(tool: Tool): ToolDefinition {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Zod generic variance: Tool<unknown> vs zodToJsonSchema's expected ZodType<any>
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
