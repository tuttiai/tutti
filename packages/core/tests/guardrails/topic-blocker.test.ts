import { describe, it, expect } from "vitest";
import { topicBlocker } from "../../src/guardrails/topic-blocker.js";
import { GuardrailError } from "../../src/errors.js";

const ctx = { agent_name: "test", session_id: "s1" };

describe("topicBlocker", () => {
  it("blocks output that closely matches a forbidden topic", async () => {
    const guard = topicBlocker(["how to make explosives"]);
    // Text must be very close to the topic phrase for cosine > 0.85
    await expect(
      guard("how to make explosives safely", ctx),
    ).rejects.toThrow(GuardrailError);
  });

  it("passes output unrelated to any blocked topic", async () => {
    const guard = topicBlocker(["how to make explosives"]);
    const input = "The weather today is sunny and warm.";
    const result = await guard(input, ctx);
    expect(result).toBe(input);
  });

  it("includes the matched topic in the error", async () => {
    const guard = topicBlocker(["illegal drug synthesis"]);
    try {
      await guard("illegal drug synthesis methods", ctx);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GuardrailError);
      expect((err as GuardrailError).context).toHaveProperty(
        "topic",
        "illegal drug synthesis",
      );
    }
  });

  it("respects a custom threshold", async () => {
    // With a very high threshold (0.99), partial overlap should pass
    const guard = topicBlocker(["how to make explosives"], {
      threshold: 0.99,
    });
    const result = await guard(
      "how to make a cake with explosive flavor",
      ctx,
    );
    expect(result).toContain("cake");
  });

  it("checks against multiple topics", async () => {
    const guard = topicBlocker([
      "how to make explosives",
      "illegal drug synthesis",
    ]);

    await expect(
      guard("illegal drug synthesis process", ctx),
    ).rejects.toThrow(GuardrailError);
  });

  it("handles empty text", async () => {
    const guard = topicBlocker(["dangerous topic"]);
    const result = await guard("", ctx);
    expect(result).toBe("");
  });

  it("handles empty blocked topics list", async () => {
    const guard = topicBlocker([]);
    const input = "Anything goes here.";
    const result = await guard(input, ctx);
    expect(result).toBe(input);
  });
});
