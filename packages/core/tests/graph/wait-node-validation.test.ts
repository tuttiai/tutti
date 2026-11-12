import { describe, it, expect } from "vitest";
import { END } from "../../src/graph/types.js";
import { GraphValidationError } from "../../src/graph/errors.js";
import { configWith, construct, gate } from "./wait-fixtures.js";

class Money {
  constructor(readonly amount: number) {}
}

/** Construct with `waits` and return the validation error it throws. */
function errorFor(waits: unknown[], extra?: Parameters<typeof configWith>[1]): GraphValidationError {
  try {
    construct(configWith(waits, extra));
  } catch (err) {
    if (err instanceof GraphValidationError) return err;
    throw err;
  }
  throw new Error("expected GraphValidationError");
}

function nest(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let i = 0; i < depth; i += 1) value = { next: value };
  return value;
}

describe("wait node: rejected", () => {
  it.each(["", "   ", "\t\n"])("rejects the event name %j", (event) => {
    const err = errorFor([gate({ event })]);
    expect(err.context).toMatchObject({ node_id: "gate", field: "event" });
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity, -Infinity])("rejects after_ms %s", (after_ms) => {
    const err = errorFor([gate({ timeout: { after_ms, to: "done" } })]);
    expect(err.context).toMatchObject({ node_id: "gate", field: "timeout.after_ms" });
  });

  it("rejects a timeout with no branch", () => {
    const err = errorFor([gate({ timeout: { after_ms: 10 } })]);
    expect(err.context).toMatchObject({ field: "timeout.to" });
  });

  it("rejects a timeout branch to an unknown node", () => {
    const err = errorFor([gate({ timeout: { after_ms: 10, to: "nowhere" } })]);
    expect(err.context).toMatchObject({ node_id: "gate", field: "timeout.to" });
    expect(err.message).toContain("nowhere");
  });

  it("rejects unknown keys such as timeout_ms", () => {
    const err = errorFor([gate({ timeout_ms: 10 })]);
    expect(err.message).toContain("timeout_ms");
    expect(errorFor([gate({ timeout: { after_ms: 1, to: END, extra: 1 } })])).toBeTruthy();
  });

  it.each([
    ["a function", { f: (): number => 1 }],
    ["a symbol", { s: Symbol("x") }],
    ["a bigint", { n: BigInt(1) }],
    ["an undefined value", { u: undefined }],
    ["NaN", { n: Number.NaN }],
    ["Infinity", { n: Infinity }],
    ["a Date", { d: new Date(0) }],
    ["a class instance", { m: new Money(5) }],
    ["a class instance at the top level", new Money(5)],
    ["an array at the top level", [1, 2]],
    ["a primitive at the top level", "paid"],
  ])("rejects a match holding %s", (_name, match) => {
    const err = errorFor([gate({ match })]);
    expect(err.context).toMatchObject({ node_id: "gate" });
    expect(String(err.context["field"])).toMatch(/^match/);
  });

  it("rejects an id already used by an agent node", () => {
    const err = errorFor([gate({ id: "done" })]);
    expect(err.context).toEqual({ duplicates: ["done"] });
  });

  it("rejects two waits with the same id", () => {
    const err = errorFor([gate(), gate({ event: "other" })]);
    expect(err.context).toEqual({ duplicates: ["gate"] });
  });

  it("rejects the reserved id __end__", () => {
    expect(errorFor([gate(), gate({ id: END })]).context).toMatchObject({ field: "id" });
  });

  it("rejects a wait node as the entrypoint", () => {
    const config = { ...configWith([gate()]), entrypoint: "gate" };
    expect(() => construct(config)).toThrow(/cannot be the entrypoint/);
  });

  it("rejects a wait node as the target of a parallel edge", () => {
    const err = errorFor([gate()], [{ from: "start", to: "gate", parallel: true }]);
    expect(err.context).toMatchObject({ node_id: "gate", field: "edge" });
  });

  it("rejects a wait node with no outgoing edge", () => {
    const config = configWith([gate(), gate({ id: "orphan" })]);
    expect(() => construct(config)).toThrow(/"orphan" has no outgoing edges/);
  });

  it("still rejects an edge to an id that is neither a node nor a wait", () => {
    expect(() => construct(configWith([]))).toThrow(/Edge to "gate"/);
  });

  it("rejects a wrong kind, a missing id and a non-array waits", () => {
    expect(errorFor([gate({ kind: "agent" })]).context).toMatchObject({ field: "kind" });
    expect(errorFor([gate({ id: undefined })]).context).toMatchObject({ node_id: "waits[0]" });
    const config = { ...configWith([]), waits: undefined };
    Reflect.set(config, "waits", { kind: "wait" });
    expect(() => construct(config)).toThrow(/expected an array/);
  });
});

describe("wait node: security", () => {
  it("rejects a cyclic match without recursing forever", () => {
    const match: Record<string, unknown> = { a: 1 };
    match["self"] = match;
    expect(errorFor([gate({ match })]).message).toContain("not JSON-serialisable");
  });

  it("rejects a __proto__ key and leaves Object.prototype untouched", () => {
    const match: unknown = JSON.parse('{"__proto__": {"polluted": true}}');
    expect(errorFor([gate({ match })]).message).toContain("__proto__");
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("rejects a nested constructor key", () => {
    const match = { a: JSON.parse('{"constructor": {"prototype": 1}}') as unknown };
    expect(errorFor([gate({ match })]).message).toContain("constructor");
  });

  it("accepts nesting up to the limit and rejects deeper nesting", () => {
    expect(() => construct(configWith([gate({ match: nest(30) })]))).not.toThrow();
    expect(errorFor([gate({ match: nest(40) })]).message).toContain("nesting deeper");
  });

  it("rejects very deep nesting without a stack overflow", () => {
    expect(errorFor([gate({ match: nest(20_000) })]).context).toMatchObject({ field: "match" });
  });

  it("does not echo the match payload into the error context", () => {
    const err = errorFor([gate({ match: { token: "secret-value", f: (): void => undefined } })]);
    expect(JSON.stringify(err.context)).not.toContain("secret-value");
  });
});
