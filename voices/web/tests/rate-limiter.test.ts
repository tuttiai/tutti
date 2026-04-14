import { describe, it, expect } from "vitest";
import { ToolRateLimiter, RateLimitError } from "../src/rate-limiter.js";

describe("ToolRateLimiter", () => {
  it("allows calls under the limit", () => {
    const limiter = new ToolRateLimiter(3);
    expect(() => limiter.check("web_search")).not.toThrow();
    expect(() => limiter.check("web_search")).not.toThrow();
    expect(() => limiter.check("web_search")).not.toThrow();
  });

  it("throws RateLimitError when the limit is exceeded", () => {
    const limiter = new ToolRateLimiter(2);
    limiter.check("web_search");
    limiter.check("web_search");

    expect(() => limiter.check("web_search")).toThrow(RateLimitError);
  });

  it("includes tool name and limit in the error", () => {
    const limiter = new ToolRateLimiter(1);
    limiter.check("fetch_url");

    try {
      limiter.check("fetch_url");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      const rl = err as RateLimitError;
      expect(rl.tool).toBe("fetch_url");
      expect(rl.limit).toBe(1);
      expect(rl.code).toBe("TOOL_RATE_LIMITED");
    }
  });

  it("tracks tools independently", () => {
    const limiter = new ToolRateLimiter(1);
    limiter.check("web_search");
    // Different tool — should not be blocked.
    expect(() => limiter.check("fetch_url")).not.toThrow();
  });

  it("reset() clears all tracked state", () => {
    const limiter = new ToolRateLimiter(1);
    limiter.check("web_search");
    limiter.reset();
    // Should be allowed again after reset.
    expect(() => limiter.check("web_search")).not.toThrow();
  });
});
