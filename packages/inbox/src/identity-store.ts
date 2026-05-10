import type { IdentityStore } from "./types.js";

/**
 * In-memory {@link IdentityStore} backed by a union-find with path
 * compression. `link()` merges two identities into a single
 * equivalence class so that subsequent `resolve()` calls on either
 * one return the same session id.
 *
 * Suitable for single-process deployments and tests. For multi-process
 * setups, swap in a Postgres- or Redis-backed implementation that
 * preserves the same semantics.
 */
export class InMemoryIdentityStore implements IdentityStore {
  /** Union-find parent pointer. Missing keys are their own parents. */
  private readonly parent = new Map<string, string>();
  /** Bindings keyed by union-find ROOT — never by leaf identity. */
  private readonly bindings = new Map<string, string>();

  /** Find with path compression. Iterative to avoid stack growth on long chains. */
  private find(id: string): string {
    let cursor = id;
    while (true) {
      const next = this.parent.get(cursor);
      if (next === undefined || next === cursor) {
        // Cursor is the root.
        if (cursor !== id) {
          // Compress: point id and any intermediates straight at the root.
          this.parent.set(id, cursor);
        }
        return cursor;
      }
      cursor = next;
    }
  }

  resolve(identity: string): Promise<string | null> {
    const root = this.find(identity);
    return Promise.resolve(this.bindings.get(root) ?? null);
  }

  bind(identity: string, session_id: string): Promise<void> {
    const root = this.find(identity);
    this.bindings.set(root, session_id);
    return Promise.resolve();
  }

  link(a: string, b: string): Promise<void> {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return Promise.resolve();

    // Unify under rootA. If only one side has a binding, propagate it
    // to the new root; if both do, the surviving binding is rootA's
    // (documented contract — `link(a, b)` favours `a`).
    const sessionA = this.bindings.get(rootA);
    const sessionB = this.bindings.get(rootB);
    this.parent.set(rootB, rootA);
    if (rootB !== rootA && this.bindings.has(rootB)) {
      this.bindings.delete(rootB);
    }
    if (!sessionA && sessionB) {
      this.bindings.set(rootA, sessionB);
    }
    return Promise.resolve();
  }

  /** For tests and diagnostics — number of distinct identities tracked. */
  get _size(): number {
    return this.parent.size;
  }
}

/**
 * Build the canonical cross-platform identity key from the
 * platform-native fields of an {@link InboxMessage}. Centralised so
 * adapters and consumers can't drift on the format.
 */
export function identityKey(platform: string, platform_user_id: string): string {
  return `${platform}:${platform_user_id}`;
}
