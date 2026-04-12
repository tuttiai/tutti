import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  Permission,
  Tool,
  ToolContext,
  ToolResult,
  Voice,
  VoiceContext,
} from "@tuttiai/types";

export interface McpVoiceOptions {
  /** MCP server command, e.g. 'npx @playwright/mcp' */
  server: string;
  /** Additional CLI arguments appended after the server command. */
  args?: string[];
  /** Extra environment variables passed to the server process. */
  env?: Record<string, string>;
  /** Override the voice name (default: mcp-<server-name>). */
  name?: string;
}

export class McpVoice implements Voice {
  name: string;
  description = "MCP server bridge";
  required_permissions: Permission[] = ["network"];
  tools: Tool[] = [];

  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;
  private initialized = false;

  constructor(private options: McpVoiceOptions) {
    const lastSegment = options.server.split(/[\s/]/).filter(Boolean).at(-1) ?? "server";
    this.name = options.name ?? "mcp-" + lastSegment;
  }

  async setup(_context: VoiceContext): Promise<void> {
    if (this.initialized) return;

    const [command, ...cmdArgs] = this.options.server.split(/\s+/);

    this.transport = new StdioClientTransport({
      command,
      args: [...cmdArgs, ...(this.options.args ?? [])],
      env: this.options.env,
      stderr: "pipe",
    });

    this.client = new Client(
      { name: "tutti", version: "1.0.0" },
    );

    await this.client.connect(this.transport);
    this.tools = await this.discoverTools();
    this.initialized = true;
  }

  async teardown(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = undefined;
    }
    this.transport = undefined;
    this.tools = [];
    this.initialized = false;
  }

  private async discoverTools(): Promise<Tool[]> {
    if (!this.client) throw new Error("MCP client not connected");

    const { tools: mcpTools } = await this.client.listTools();

    return mcpTools.map((mcpTool) => {
      const schema = jsonSchemaToZod(mcpTool.inputSchema as Record<string, unknown>);

      return {
        name: mcpTool.name,
        description: mcpTool.description ?? "",
        parameters: schema,
        execute: (input: unknown, _context: ToolContext): Promise<ToolResult> => {
          return this.callMcpTool(mcpTool.name, input as Record<string, unknown>);
        },
      };
    });
  }

  private async callMcpTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (!this.client) {
      return { content: "MCP client not connected", is_error: true };
    }

    const result = await this.client.callTool({ name, arguments: args });

    // MCP result.content is an array of { type: "text", text: string } blocks
    const text = (result.content as { type: string; text?: string }[])
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join("\n");

    return {
      content: text || "(no output)",
      is_error: result.isError === true,
    };
  }
}

// ---------------------------------------------------------------------------
// JSON Schema → Zod converter (covers common MCP tool schemas)
// ---------------------------------------------------------------------------

function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
  const properties = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  const required = (schema.required as string[]) ?? [];

  if (!properties) {
    return z.record(z.unknown());
  }

  const shape: Record<string, z.ZodType> = {};
  for (const [key, prop] of Object.entries(properties)) {
    let field = convertType(prop);
    if (prop.description) {
      field = field.describe(prop.description as string);
    }
    if (!required.includes(key)) {
      field = field.optional() as unknown as z.ZodType;
    }
    shape[key] = field;
  }

  return z.object(shape).passthrough();
}

function convertType(prop: Record<string, unknown>): z.ZodType {
  if (prop.enum) {
    const values = prop.enum as string[];
    if (values.length > 0) {
      return z.enum(values as [string, ...string[]]);
    }
  }

  switch (prop.type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(z.unknown());
    case "object":
      return z.record(z.unknown());
    default:
      return z.unknown();
  }
}
