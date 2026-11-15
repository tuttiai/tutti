import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks";
import type { CreateTaskRequestHandlerExtra } from "@modelcontextprotocol/sdk/experimental/tasks";
import type { RequestTaskStore } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ContentBlock, Task } from "@modelcontextprotocol/sdk/types.js";

/** Poll interval the test server asks for, in ms. */
export const POLL_MS = 100;

/** Drives the task the server created for the last call, and breaks the server on demand. */
export class TaskControl {
  store: RequestTaskStore | undefined;
  taskId = "";
  /** `tasks/get` throws while set. */
  breakGet = false;
  /** `tasks/get` reports this status instead of the real one while set. */
  fakeStatus: string | undefined;
  /** `tools/call` never answers while set. */
  holdCreate = false;

  async status(message: string): Promise<void> {
    await this.need().updateTaskStatus(this.taskId, "working", message);
  }

  async finish(content: ContentBlock[], isError = false): Promise<void> {
    await this.need().storeTaskResult(this.taskId, "completed", { content, isError });
  }

  async fail(message: string): Promise<void> {
    await this.need().updateTaskStatus(this.taskId, "failed", message);
  }

  private need(): RequestTaskStore {
    if (!this.store) throw new Error("no task created yet");
    return this.store;
  }
}

/** The server answers `tasks/get` from its store, so the faults live here. */
class FaultyTaskStore extends InMemoryTaskStore {
  constructor(private readonly control: TaskControl) {
    super();
  }

  override async getTask(taskId: string, sessionId?: string): Promise<Task | null> {
    if (this.control.breakGet) throw new Error("task store offline");
    const task = await super.getTask(taskId, sessionId);
    if (!task || this.control.fakeStatus === undefined) return task;
    // Safe for a test: a status the protocol does not define, on purpose.
    return { ...task, status: this.control.fakeStatus } as Task;
  }
}

async function create(control: TaskControl, extra: CreateTaskRequestHandlerExtra) {
  if (control.holdCreate) await new Promise<never>(() => {});
  const task = await extra.taskStore.createTask({ ttl: null, pollInterval: POLL_MS });
  control.store = extra.taskStore;
  control.taskId = task.taskId;
  const progressToken = extra._meta?.progressToken;
  if (progressToken !== undefined) {
    await extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress: 1, total: 4, message: "page 1 of 4" },
    });
  }
  return { task };
}

/**
 * A server with one task tool, `crawl`. With `tasks: false` the tool still
 * advertises `taskSupport` but the server declares no task capability.
 */
export function taskServer(options: { taskSupport: "optional" | "required"; tasks: boolean }): { server: McpServer; control: TaskControl } {
  const control = new TaskControl();
  const capabilities = { tasks: { requests: { tools: { call: {} } }, cancel: {} } };
  const server = new McpServer(
    { name: "tasks", version: "1.0.0" },
    options.tasks ? { capabilities, taskStore: new FaultyTaskStore(control) } : {},
  );
  server.experimental.tasks.registerToolTask("crawl", { description: "Crawls", execution: { taskSupport: options.taskSupport } }, {
    createTask: (extra) => create(control, extra),
    async getTask({ taskId, taskStore }) {
      return await taskStore.getTask(taskId);
    },
    async getTaskResult({ taskId, taskStore }) {
      // Safe: finish() stores a CallToolResult for this task.
      return (await taskStore.getTaskResult(taskId)) as CallToolResult;
    },
  });
  return { server, control };
}
