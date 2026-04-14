import { describe, it, expect } from "vitest";
import { profanityFilter } from "../../src/guardrails/profanity-filter.js";

const ctx = { agent_name: "test", session_id: "s1" };

describe("profanityFilter", () => {
  it("replaces profanity with [filtered]", async () => {
    const guard = profanityFilter();
    const result = await guard("What the fuck is going on?", ctx);
    expect(result).toBe("What the [filtered] is going on?");
  });

  it("is case-insensitive", async () => {
    const guard = profanityFilter();
    const result = await guard("That is BULLSHIT and Damn annoying", ctx);
    expect(result).toBe("That is [filtered] and [filtered] annoying");
  });

  it("matches whole words only", async () => {
    const guard = profanityFilter();
    const result = await guard("The classic poem has a passage about hell.", ctx);
    expect(result).toBe("The classic poem has a passage about [filtered].");
    // "passage" should not be affected despite containing "ass"
    expect(result).toContain("passage");
  });

  it("returns clean text unchanged", async () => {
    const guard = profanityFilter();
    const input = "This is a perfectly fine sentence.";
    const result = await guard(input, ctx);
    expect(result).toBe(input);
  });

  it("supports extra words", async () => {
    const guard = profanityFilter({ extraWords: ["dingus", "bonkers"] });
    const result = await guard("You absolute dingus, that's bonkers", ctx);
    expect(result).toBe("You absolute [filtered], that's [filtered]");
  });

  it("handles multiple profane words in a single string", async () => {
    const guard = profanityFilter();
    const result = await guard("shit fuck damn", ctx);
    expect(result).toBe("[filtered] [filtered] [filtered]");
  });
});
