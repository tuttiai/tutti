import { describe, it, expect } from "vitest";
import { END } from "../../src/graph/types.js";

describe("END sentinel", () => {
  it("equals __end__", () => {
    expect(END).toBe("__end__");
  });

  it("is a string constant usable in edge targets", () => {
    const edge = { from: "a", to: END };
    expect(edge.to).toBe("__end__");
  });
});
