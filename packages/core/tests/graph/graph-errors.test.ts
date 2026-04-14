import { describe, it, expect } from "vitest";
import {
  GraphValidationError,
  GraphCycleError,
  GraphStateError,
  GraphDeadEndError,
} from "../../src/graph/errors.js";
import { TuttiError } from "../../src/errors.js";

describe("GraphValidationError", () => {
  it("extends TuttiError with code GRAPH_INVALID", () => {
    const err = new GraphValidationError("bad config");
    expect(err).toBeInstanceOf(TuttiError);
    expect(err.code).toBe("GRAPH_INVALID");
    expect(err.message).toBe("bad config");
  });

  it("includes context", () => {
    const err = new GraphValidationError("dup", { duplicates: ["a"] });
    expect(err.context).toEqual({ duplicates: ["a"] });
  });
});

describe("GraphCycleError", () => {
  it("extends TuttiError with code GRAPH_CYCLE", () => {
    const err = new GraphCycleError("nodeA", 6, 5);
    expect(err).toBeInstanceOf(TuttiError);
    expect(err.code).toBe("GRAPH_CYCLE");
    expect(err.message).toContain("nodeA");
    expect(err.message).toContain("6");
    expect(err.message).toContain("5");
    expect(err.context).toEqual({ node_id: "nodeA", visits: 6, limit: 5 });
  });
});

describe("GraphStateError", () => {
  it("extends TuttiError with code GRAPH_STATE_INVALID", () => {
    const err = new GraphStateError("nodeB", "Expected number");
    expect(err).toBeInstanceOf(TuttiError);
    expect(err.code).toBe("GRAPH_STATE_INVALID");
    expect(err.message).toContain("nodeB");
    expect(err.message).toContain("Expected number");
  });
});

describe("GraphDeadEndError", () => {
  it("extends TuttiError with code GRAPH_DEAD_END", () => {
    const err = new GraphDeadEndError("nodeC");
    expect(err).toBeInstanceOf(TuttiError);
    expect(err.code).toBe("GRAPH_DEAD_END");
    expect(err.message).toContain("nodeC");
    expect(err.context).toEqual({ node_id: "nodeC" });
  });
});
