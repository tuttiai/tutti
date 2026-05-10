import { describe, it, expect } from "vitest";
import { InMemoryIdentityStore, identityKey } from "../src/identity-store.js";

describe("InMemoryIdentityStore", () => {
  it("resolve returns null for an unbound identity", async () => {
    const store = new InMemoryIdentityStore();
    expect(await store.resolve("telegram:42")).toBeNull();
  });

  it("bind then resolve returns the bound session id", async () => {
    const store = new InMemoryIdentityStore();
    await store.bind("telegram:42", "sess-1");
    expect(await store.resolve("telegram:42")).toBe("sess-1");
  });

  it("rebinding overrides the previous session", async () => {
    const store = new InMemoryIdentityStore();
    await store.bind("telegram:42", "sess-1");
    await store.bind("telegram:42", "sess-2");
    expect(await store.resolve("telegram:42")).toBe("sess-2");
  });

  describe("link()", () => {
    it("merges two identities so both resolve to the same session", async () => {
      const store = new InMemoryIdentityStore();
      await store.bind("telegram:42", "sess-A");
      await store.link("telegram:42", "slack:U7");
      expect(await store.resolve("telegram:42")).toBe("sess-A");
      expect(await store.resolve("slack:U7")).toBe("sess-A");
    });

    it("propagates an unbound identity's binding to the merged set", async () => {
      const store = new InMemoryIdentityStore();
      await store.bind("slack:U7", "sess-S");
      // a is unbound, b is bound — merging into a's class should
      // promote b's session as the surviving one.
      await store.link("telegram:42", "slack:U7");
      expect(await store.resolve("telegram:42")).toBe("sess-S");
      expect(await store.resolve("slack:U7")).toBe("sess-S");
    });

    it("favours `a` when both sides are already bound", async () => {
      const store = new InMemoryIdentityStore();
      await store.bind("telegram:42", "sess-A");
      await store.bind("slack:U7", "sess-S");
      await store.link("telegram:42", "slack:U7");
      // Per documented contract: link(a, b) keeps a's binding.
      expect(await store.resolve("telegram:42")).toBe("sess-A");
      expect(await store.resolve("slack:U7")).toBe("sess-A");
    });

    it("is idempotent when the two sides are already merged", async () => {
      const store = new InMemoryIdentityStore();
      await store.bind("telegram:42", "sess-A");
      await store.link("telegram:42", "slack:U7");
      await store.link("telegram:42", "slack:U7");
      await store.link("slack:U7", "telegram:42");
      expect(await store.resolve("telegram:42")).toBe("sess-A");
      expect(await store.resolve("slack:U7")).toBe("sess-A");
    });

    it("transitively merges three identities", async () => {
      const store = new InMemoryIdentityStore();
      await store.bind("telegram:42", "sess-A");
      await store.link("telegram:42", "slack:U7");
      await store.link("slack:U7", "discord:DD");
      expect(await store.resolve("discord:DD")).toBe("sess-A");
    });

    it("subsequent bind on any leaf updates the whole class", async () => {
      const store = new InMemoryIdentityStore();
      await store.link("telegram:42", "slack:U7");
      await store.bind("slack:U7", "sess-X");
      expect(await store.resolve("telegram:42")).toBe("sess-X");
    });
  });
});

describe("identityKey", () => {
  it("formats platform:user_id deterministically", () => {
    expect(identityKey("telegram", "42")).toBe("telegram:42");
    expect(identityKey("slack", "U7")).toBe("slack:U7");
  });
});
