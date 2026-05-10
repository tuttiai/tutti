import { createRequire } from "node:module";
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

const require = createRequire(import.meta.url);
const PKG_VERSION: string = (require("../package.json") as { version: string }).version;

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

interface McpTextBlock {
  type: "text";
  text: string;
}

/** Split a command string into [command, ...args]. Does not handle quoted arguments. */
function parseCommand(server: string): [string, string[]] {
  const parts = server.split(/\s+/).filter(Boolean);
  const command = parts[0] ?? "echo";
  return [command, parts.slice(1)];
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

    const [command, cmdArgs] = parseCommand(this.options.server);

    this.transport = new StdioClientTransport({
      command,
      args: [...cmdArgs, ...(this.options.args ?? [])],
      env: this.options.env,
      stderr: "pipe",
    });

    this.client = new Client(
      { name: "tutti", version: PKG_VERSION },
    );

    await this.client.connect(this.transport);

    // Drain stderr so the child process doesn't stall from backpressure.
    // Errors are non-fatal — the server may log diagnostics we don't need.
    const stderr = this.transport.stderr;
    if (stderr) {
      stderr.on("data", () => { /* discard */ });
    }

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
      const raw = mcpTool.inputSchema;
      const schema = jsonSchemaToZod(
        typeof raw === "object" && raw !== null ? raw : {},
      );

      return {
        name: mcpTool.name,
        description: mcpTool.description ?? "",
        parameters: schema,
        execute: async (input: unknown, _context: ToolContext): Promise<ToolResult> => {
          try {
            // Safe: input has been parsed by the Zod schema derived from the MCP tool's inputSchema.
            return await this.callMcpTool(mcpTool.name, input as Record<string, unknown>);
          } catch (err) {
            return {
              content: err instanceof Error ? err.message : String(err),
              is_error: true,
            };
          }
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

    const blocks: { type: string; text?: string }[] = Array.isArray(result.content)
      ? (result.content as { type: string; text?: string }[])
      : [];
    const text = blocks
      .filter((c): c is McpTextBlock => c.type === "text" && typeof c.text === "string")
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

function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  const properties = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((v): v is string => typeof v === "string")
    : [];

  if (!properties) {
    return z.record(z.unknown());
  }

  const shapeMap = new Map<string, z.ZodTypeAny>();
  for (const [key, prop] of Object.entries(properties)) {
    let field: z.ZodTypeAny = convertType(prop);
    if (typeof prop.description === "string") {
      field = field.describe(prop.description);
    }
    if (!required.includes(key)) {
      field = field.optional();
    }
    shapeMap.set(key, field);
  }

  return z.object(Object.fromEntries(shapeMap)).passthrough();
}

function convertType(prop: Record<string, unknown>): z.ZodTypeAny {
  if (Array.isArray(prop.enum)) {
    const strings = prop.enum.filter((v): v is string => typeof v === "string");
    if (strings.length > 0) {
      return z.enum(strings as [string, ...string[]]);
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
