import { randomUUID } from "node:crypto";

import type { InterruptStore } from "./store.js";
import type {
  InterruptCreateInput,
  InterruptRequest,
  ResolveOptions,
} from "./types.js";

/**
 * In-process {@link InterruptStore} backed by a `Map<interrupt_id, InterruptRequest>`.
 *
 * Suitable for tests, local dev, and single-process deployments where
 * operator approval lives in the same runtime. **Do not use across
 * processes** — requests are lost on restart, and two processes using
 * separate instances won't see each other's requests.
 */
export class MemoryInterruptStore implements InterruptStore {
  private readonly byId = new Map<string, InterruptRequest>();

  create(input: InterruptCreateInput): Promise<InterruptRequest> {
    const request: InterruptRequest = {
      interrupt_id: randomUUID(),
      session_id: input.session_id,
      tool_name: input.tool_name,
      tool_args: input.tool_args,
      requested_at: new Date(),
      status: "pending",
    };
    this.byId.set(request.interrupt_id, request);
    return Promise.resolve(request);
  }

  get(interrupt_id: string): Promise<InterruptRequest | null> {
    return Promise.resolve(this.byId.get(interrupt_id) ?? null);
  }

  resolve(
    interrupt_id: string,
    status: "approved" | "denied",
    options: ResolveOptions = {},
  ): Promise<InterruptRequest> {
    const existing = this.byId.get(interrupt_id);
    if (!existing) {
      return Promise.reject(
        new Error("MemoryInterruptStore: unknown interrupt_id " + interrupt_id),
      );
    }
    // Idempotent — a duplicate resolution of an already-resolved
    // request returns the existing record unchanged. This lets UIs
    // survive duplicate operator clicks without error toasts.
    if (existing.status !== "pending") {
      return Promise.resolve(existing);
    }

    const resolved: InterruptRequest = {
      ...existing,
      status,
      resolved_at: new Date(),
      ...(options.resolved_by !== undefined ? { resolved_by: options.resolved_by } : {}),
      ...(options.denial_reason !== undefined
        ? { denial_reason: options.denial_reason }
        : {}),
    };
    this.byId.set(interrupt_id, resolved);
    return Promise.resolve(resolved);
  }

  listPending(session_id?: string): Promise<InterruptRequest[]> {
    const pending: InterruptRequest[] = [];
    for (const r of this.byId.values()) {
      if (r.status !== "pending") continue;
      if (session_id !== undefined && r.session_id !== session_id) continue;
      pending.push(r);
    }
    // Oldest first — standard review-queue ordering.
    pending.sort((a, b) => a.requested_at.getTime() - b.requested_at.getTime());
    return Promise.resolve(pending);
  }
}
