/**
 * `GET /realtime` — WebSocket endpoint that proxies the OpenAI Realtime
 * API to a browser, plus `GET /realtime-demo` — a public HTML page that
 * exercises the endpoint with the user's microphone.
 *
 * Auth runs inline (the global bearer-auth hook bypasses both routes)
 * because browsers cannot set an `Authorization` header on
 * `new WebSocket(url)`. Clients pass the API key as `?api_key=...`.
 *
 * Frames are JSON-encoded on both sides; binary audio is carried
 * base64-inline so the demo page only deals with text frames. See
 * `realtime-bridge.ts` for the inbound/outbound frame shapes.
 */

import { SecretsManager } from "@tuttiai/core";
import type { TuttiRuntime } from "@tuttiai/core";
import { RealtimeSession, RealtimeVoice } from "@tuttiai/realtime";
import type { RealtimeConfig } from "@tuttiai/realtime";
import type { AgentConfig, RealtimeAgentConfig, ScoreConfig, Tool } from "@tuttiai/types";
import type { FastifyInstance } from "fastify";
import type { RawData, WebSocket } from "ws";

import { authorize, handleInbound, send, wireSessionToSocket } from "./realtime-bridge.js";
import { realtimeDemoHtml } from "./realtime-demo-html.js";

const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";

/** Public paths registered by this module — used by the auth allowlist. */
export const REALTIME_PUBLIC_PATHS: readonly string[] = ["/realtime", "/realtime-demo"];

interface RealtimeRouteOptions {
  runtime: TuttiRuntime;
  score: ScoreConfig;
  agentName: string;
  apiKey: string | undefined;
}

/**
 * Register `GET /realtime` (WebSocket) and `GET /realtime-demo` (static
 * HTML demo). The Fastify instance must already have
 * `@fastify/websocket` registered.
 */
export function registerRealtimeRoutes(
  app: FastifyInstance,
  options: RealtimeRouteOptions,
): void {
  app.get("/realtime-demo", (_req, reply) => {
    void reply
      .type("text/html; charset=utf-8")
      .header("cache-control", "no-cache")
      .send(realtimeDemoHtml);
  });

  app.get<{ Querystring: { api_key?: string } }>(
    "/realtime",
    { websocket: true },
    (socket, request) => {
      void handleConnection(socket, request.query.api_key, options);
    },
  );
}

async function handleConnection(
  socket: WebSocket,
  queryKey: string | undefined,
  options: RealtimeRouteOptions,
): Promise<void> {
  if (!authorize(queryKey, options.apiKey)) {
    send(socket, { type: "error", message: "unauthorized" });
    socket.close(4401, "unauthorized");
    return;
  }
  const agent = options.score.agents[options.agentName];
  if (!agent) {
    send(socket, { type: "error", message: "agent_not_found" });
    socket.close(4404, "agent_not_found");
    return;
  }
  const realtime = resolveRealtimeConfig(agent);
  if (!realtime) {
    send(socket, { type: "error", message: "realtime_disabled_for_agent" });
    socket.close(4404, "realtime_disabled_for_agent");
    return;
  }
  const openaiKey = SecretsManager.optional(OPENAI_API_KEY_ENV);
  if (!openaiKey) {
    send(socket, { type: "error", message: "missing_openai_api_key" });
    socket.close(4500, "missing_openai_api_key");
    return;
  }
  await openSession(socket, agent, realtime, openaiKey, options.runtime);
}

async function openSession(
  socket: WebSocket,
  agent: AgentConfig,
  realtime: RealtimeConfig,
  openaiKey: string,
  runtime: TuttiRuntime,
): Promise<void> {
  // "Auto-load" the realtime voice's tools alongside the agent's
  // existing tools so an agent doesn't have to add `RealtimeVoice(...)`
  // to its `voices` array manually.
  const realtimeTools = RealtimeVoice(realtime).tools;
  const tools: Tool[] = [...collectAgentTools(agent), ...realtimeTools];

  const session = new RealtimeSession({
    config: realtime,
    tools,
    agent,
    events: runtime.events,
    session_id: `realtime-${Date.now()}`,
  });
  wireSessionToSocket(session, socket);

  socket.on("message", (data: RawData) => handleInbound(rawDataToString(data), session, socket));
  socket.on("close", () => session.close());

  try {
    await session.connect(openaiKey);
    send(socket, { type: "ready", model: realtime.model, voice: realtime.voice });
  } catch (err) {
    send(socket, {
      type: "error",
      message: SecretsManager.redact(err instanceof Error ? err.message : "connect_failed"),
    });
    socket.close(4500, "connect_failed");
  }
}

function collectAgentTools(agent: AgentConfig): Tool[] {
  const tools: Tool[] = [];
  for (const voice of agent.voices) {
    for (const tool of voice.tools) tools.push(tool);
  }
  return tools;
}

function resolveRealtimeConfig(agent: AgentConfig): RealtimeAgentConfig | undefined {
  if (agent.realtime === undefined || agent.realtime === false) return undefined;
  return agent.realtime;
}

/** Coerce ws's `RawData` (Buffer | ArrayBuffer | Buffer[]) to UTF-8 string. */
function rawDataToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}
