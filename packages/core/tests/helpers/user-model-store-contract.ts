/**
 * Shared behaviour every {@link UserModelStore} must have. Each backend's
 * test file calls {@link runUserModelStoreContract} with a factory, so the
 * in-memory and Postgres stores are held to exactly the same cases.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  emptyProfile,
  type UserModelStore,
  type UserProfile,
} from "../../src/memory/user-model.js";

/** A store under test and how to release it after each case. */
export interface ContractStore {
  store: UserModelStore;
  cleanup(): Promise<void>;
}

/** Builds a fresh {@link ContractStore} for one test case. */
export type MakeContractStore = () => Promise<ContractStore>;

const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
let counter = 0;

/** A user id unique to this run and case, so cases sharing a table never collide. */
function uid(label: string): string {
  counter += 1;
  return label + "-" + RUN + "-" + String(counter);
}

function profile(user_id: string, overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    user_id,
    summary: "Builds agents in TypeScript.",
    preferences: { communication_style: "terse", language: "en-GB" },
    ongoing_projects: ["tutti", "voices"],
    turn_count: 42,
    last_consolidated_turn: 40,
    ...overrides,
  };
}

const AWKWARD = "Grüße 👋 \"quoted\" 'single' back\\slash\nnew line\ttab {braces} [x]";
const INJECTION = "'; DROP TABLE tutti_user_profiles; --";

/**
 * Register the {@link UserModelStore} contract as a `describe` block.
 *
 * @param name - Label for the backend, shown in the test report.
 * @param makeStore - Called before every case; its `cleanup` runs after it.
 */
export function runUserModelStoreContract(name: string, makeStore: MakeContractStore): void {
  describe(name + " satisfies the UserModelStore contract", () => {
    let handle: ContractStore;
    let store: UserModelStore;

    beforeEach(async () => {
      handle = await makeStore();
      store = handle.store;
    });

    afterEach(async () => {
      await handle.cleanup();
    });

    async function roundTrip(p: UserProfile): Promise<void> {
      await store.upsert(p);
      expect(await store.get(p.user_id)).toEqual(p);
    }

    it("returns null for a user with no profile", async () => {
      await expect(store.get(uid("missing"))).resolves.toBeNull();
    });

    it("round-trips an empty bootstrap profile", async () => {
      await roundTrip(emptyProfile(uid("empty")));
    });

    it("round-trips a full profile with its counters exactly", async () => {
      await roundTrip(profile(uid("full"), { turn_count: 2_000_000, last_consolidated_turn: 1_999_990 }));
    });

    it("replaces the whole record on a second upsert", async () => {
      const id = uid("replace");
      await store.upsert(profile(id));
      const next = profile(id, { summary: "New.", preferences: { tone: "warm" }, ongoing_projects: [], turn_count: 43 });
      await roundTrip(next);
    });

    it("is not changed by mutating a returned or written object", async () => {
      const id = uid("clone");
      const written = profile(id);
      await store.upsert(written);
      written.preferences.injected = "yes";
      written.ongoing_projects.push("injected");
      const got = await store.get(id);
      if (got) {
        got.summary = "mutated";
        got.preferences.other = "mutated";
        got.ongoing_projects.push("mutated");
      }
      expect(await store.get(id)).toEqual(profile(id));
    });

    it("deletes a profile so it reads as null", async () => {
      const id = uid("delete");
      await store.upsert(profile(id));
      await store.delete(id);
      await expect(store.get(id)).resolves.toBeNull();
    });

    it("treats deleting an unknown user as a no-op", async () => {
      await expect(store.delete(uid("never"))).resolves.toBeUndefined();
    });

    it("leaves other users untouched on upsert and delete", async () => {
      const keep = profile(uid("keep"));
      const drop = uid("drop");
      await store.upsert(keep);
      await store.upsert(profile(drop, { summary: "Other user." }));
      await store.delete(drop);
      expect(await store.get(keep.user_id)).toEqual(keep);
    });

    it("round-trips unicode, emoji, quotes, backslashes and newlines", async () => {
      await roundTrip(
        profile(uid("awkward " + AWKWARD), {
          summary: AWKWARD,
          preferences: { [AWKWARD]: AWKWARD, "emoji_🎻": "🎺" },
          ongoing_projects: [AWKWARD, "", "NULL", "a,b"],
        }),
      );
    });

    it("stores SQL metacharacters as plain data", async () => {
      await roundTrip(
        profile(uid(INJECTION), {
          summary: INJECTION,
          preferences: { [INJECTION]: INJECTION },
          ongoing_projects: [INJECTION],
        }),
      );
    });

    it("round-trips empty preferences and projects", async () => {
      await roundTrip(profile(uid("bare"), { preferences: {}, ongoing_projects: [] }));
    });

    it("stores a summary over 4000 characters unchanged", async () => {
      await roundTrip(profile(uid("long"), { summary: "x".repeat(4_001) + "é".repeat(999) }));
    });

    it("round-trips 1,000 preference keys", async () => {
      const preferences: Record<string, string> = {};
      for (let i = 0; i < 1_000; i += 1) preferences["key_" + String(i)] = "value " + String(i);
      await roundTrip(profile(uid("many"), { preferences }));
    });

    it("keeps one profile, equal to one of the writes, after 10 concurrent upserts", async () => {
      const id = uid("race");
      const writes = Array.from({ length: 10 }, (_, i) => profile(id, { summary: "write " + String(i), turn_count: i }));
      await Promise.all(writes.map((w) => store.upsert(w)));
      const got = await store.get(id);
      expect(writes).toContainEqual(got);
    });
  });
}
