/**
 * Voice factory that exposes the OpenAI Realtime API to a Tutti agent.
 *
 * The returned {@link Voice} carries one tool — `start_realtime_session`
 * — that signals readiness to begin a realtime turn. Actual audio I/O
 * happens out-of-band in the consuming application via
 * {@link RealtimeSession} or {@link RealtimeClient}; this factory's job
 * is to advertise the capability through the standard voice contract so
 * `requireApproval`, permissions, and cost accounting all flow through
 * the existing runtime.
 */

import { z } from "zod";

import type { Permission, Tool, Voice } from "@tuttiai/types";

import type { RealtimeConfig } from "./types.js";

const NAME = "realtime";
const REQUIRED_PERMISSIONS: Permission[] = ["network"];

/**
 * Build the `start_realtime_session` {@link Tool}. Returns a small JSON
 * payload describing the session so an agent that called it can choose
 * to fall back to text or hand control to the realtime path.
 */
function createStartTool(config: RealtimeConfig): Tool<{ instructions?: string }> {
  return {
    name: "start_realtime_session",
    description:
      "Open an OpenAI Realtime audio session. Returns the session config the application should use to wire audio I/O.",
    parameters: z.object({
      instructions: z
        .string()
        .optional()
        .describe("Override the default system prompt for this realtime session."),
    }),
    execute: (input) => {
      const payload = {
        status: "ready",
        model: config.model,
        voice: config.voice,
        turn_detection: config.turnDetection,
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      };
      return Promise.resolve({ content: JSON.stringify(payload) });
    },
  };
}

/**
 * Build a Tutti {@link Voice} that surfaces the OpenAI Realtime API.
 *
 * @example
 * ```ts
 * const voice = RealtimeVoice({
 *   model: "gpt-4o-realtime-preview",
 *   voice: "alloy",
 *   turnDetection: { type: "server_vad" },
 * });
 *
 * defineScore({
 *   agents: {
 *     concierge: {
 *       name: "concierge",
 *       system_prompt: "Be concise.",
 *       voices: [voice],
 *       permissions: ["network"],
 *     },
 *   },
 * });
 * ```
 */
export function RealtimeVoice(config: RealtimeConfig): Voice {
  return {
    name: NAME,
    description: "OpenAI Realtime API — voice / audio conversation surface",
    required_permissions: REQUIRED_PERMISSIONS,
    tools: [createStartTool(config)],
  };
}
