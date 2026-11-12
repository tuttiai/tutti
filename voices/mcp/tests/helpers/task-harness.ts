import { vi } from "vitest";
import type { Tool } from "@tuttiai/types";
import { InMemoryMcpVoice, toolContext } from "./in-memory.js";
import { taskServer, type TaskControl } from "./task-server.js";

/** Everything a task test needs: a connected voice, its `crawl` tool and a context that records progress. */
export interface TaskHarness {
  voice: InMemoryMcpVoice;
  control: TaskControl;
  tool: Tool;
  updates: Record<string, unknown>[];
  controller: AbortController;
  context: typeof toolContext & { signal: AbortSignal; report_progress: (update: Record<string, unknown>) => void };
}

/** Connect a voice to a task server and find its `crawl` tool. */
export async function taskHarness(
  taskSupport: "optional" | "required" = "optional",
  tasks = true,
): Promise<TaskHarness> {
  const { server, control } = taskServer({ taskSupport, tasks });
  const voice = new InMemoryMcpVoice(server);
  await voice.setup(toolContext);
  const tool = voice.tools.find((t) => t.name === "crawl");
  if (!tool) throw new Error("crawl not discovered");
  const updates: Record<string, unknown>[] = [];
  const controller = new AbortController();
  const context = { ...toolContext, signal: controller.signal, report_progress: (u: Record<string, unknown>) => updates.push(u) };
  return { voice, control, tool, updates, controller, context };
}

/** Let pending messages through, then move the fake clock on by `ms`. */
export async function tick(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}
