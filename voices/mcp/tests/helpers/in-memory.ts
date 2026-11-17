import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolContext } from "@tuttiai/types";
import { McpVoice } from "../../src/index.js";

/** A context like the one the runtime hands every tool. */
export const toolContext: ToolContext = { session_id: "session-1", agent_name: "assistant" };

/**
 * An McpVoice connected to an in-memory server instead of a child process.
 * Records the method of every request and notification the client sends.
 */
export class InMemoryMcpVoice extends McpVoice {
  readonly sent: string[] = [];

  constructor(private readonly mcpServer: McpServer) {
    super({ server: "in-memory", name: "mcp-test" });
  }

  protected override createTransport(): Transport {
    const [client, server] = InMemoryTransport.createLinkedPair();
    void this.mcpServer.connect(server);
    const send = client.send.bind(client);
    client.send = (message, options) => {
      if ("method" in message) this.sent.push(message.method);
      return send(message, options);
    };
    return client;
  }
}

/** A server with plain tools only: no task capability. */
export function plainServer(): McpServer {
  const server = new McpServer({ name: "plain", version: "1.0.0" });
  server.registerTool("echo", { description: "Echoes", inputSchema: { text: z.string() } }, ({ text }) => ({
    content: [
      { type: "text", text },
      { type: "image", data: "aGk=", mimeType: "image/png" },
      { type: "text", text: "second" },
    ],
  }));
  server.registerTool("silent", { description: "Says nothing" }, () => ({ content: [] }));
  server.registerTool("broken", { description: "Fails" }, () => ({
    content: [{ type: "text", text: "bad input" }],
    isError: true,
  }));
  return server;
}
