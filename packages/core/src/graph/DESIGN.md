# TuttiGraph — Design Document

## Overview

`TuttiGraph` is a DAG-based execution engine that routes work through a
directed graph of agents. Each node wraps an `AgentConfig`; edges define
the flow between nodes. The engine handles conditional branching, parallel
forks, shared mutable state, and safe loop handling.

```
            ┌──────────┐
   input ──>│ classify  │
            └────┬──┬───┘
       "write"   │  │  "review"
            ┌────▼┐ ┌▼────────┐
            │write│ │ review  │
            └──┬──┘ └──┬──────┘
               │       │
            ┌──▼───────▼──┐
            │    merge     │
            └──────┬───────┘
                   │
                __end__
```

---

## 1. State Flow Between Nodes

### Input propagation

Each node receives a **text input** — a string fed to its agent's user
message. The entrypoint node receives the caller-provided `input` string
directly. Every subsequent node receives the **output text** of the node
that preceded it along the traversed edge.

```
Entrypoint node  ← receives `run(input)`
     │
  edge taken
     │
Successor node   ← receives predecessor's NodeResult.output
```

When multiple edges converge on one target (a join), the inputs from all
predecessors are concatenated with headers:

```
[from: writer]
<writer output>

[from: reviewer]
<reviewer output>
```

### Shared state

An optional shared state object flows through the entire graph. It is
defined by a Zod schema in `GraphConfig.state` and behaves like a typed
scratchpad that any node can read and mutate.

**Lifecycle:**

1. **Initialization.** At run start, `RunOptions.initial_state` is
   validated against the schema. When omitted, the state is initialized
   by calling `schema.parse({})` (schema defaults apply).

2. **Read.** Before a node executes, the current state snapshot is
   injected into the node's agent system prompt as a fenced JSON block:

   ```
   Current graph state:
   ```json
   { "draft": "...", "approved": false }
   ```
   ```

3. **Write.** After a node executes, if its `NodeResult.structured`
   object contains keys matching the state schema, those keys are
   shallow-merged into the state. This is the only mutation path — nodes
   cannot make arbitrary state changes, only write values that pass the
   schema.

4. **Validation.** After every merge the state is re-validated via
   `schema.parse(state)`. A failure throws `GraphStateError` with the
   offending node ID and the Zod error message.

5. **Return.** The final state is available as
   `GraphRunResult.final_state`.

**Why shallow merge?** Deep merge introduces ambiguity with arrays and
nested objects. Shallow merge is predictable: each node "owns" the
top-level keys it writes. If two parallel nodes write the same key, the
last to finish wins (non-deterministic) — the design doc for a specific
graph should assign disjoint keys to parallel branches.

---

## 2. Conditional Edge Evaluation

When a node completes, the engine evaluates **all** outgoing edges from
that node. The evaluation algorithm:

```
1. Collect all edges where edge.from === completed_node.id
2. Partition into:
     conditional   = edges with a `condition` function
     unconditional = edges without a `condition` function
3. Evaluate all conditional edges concurrently:
     results = await Promise.all(
       conditional.map(e => e.condition(nodeResult))
     )
4. Collect the "taken" set:
     taken = conditional edges where result === true
           + all unconditional edges
5. Branch on taken.length:
     0  → throw GraphDeadEndError(node.id)
     1  → single successor (sequential advance)
     N  → parallel fork (see Section 3)
6. If any taken edge targets END → those branches terminate;
   remaining edges are still followed.
```

### Evaluation order and short-circuiting

Conditions are evaluated concurrently, not sequentially. There is no
priority or ordering between edges. If deterministic ordering is needed,
model it as a chain of nodes with single outgoing edges instead.

### Edge to END

An edge whose `to` is `END` (`"__end__"`) does not execute another node.
Instead, the source node's output is collected as a potential
`final_output`. If the graph has multiple terminal branches (parallel
paths each reaching END), the `final_output` is the output of the last
branch to complete. All outputs are still available in
`GraphRunResult.outputs`.

---

## 3. Parallel Branches

A **fork** occurs when multiple outgoing edges from a single node are
taken simultaneously. The target nodes execute concurrently via
`Promise.all`.

```
        ┌────────┐
        │ router │
        └─┬───┬──┘
     ┌────▼┐ ┌▼────┐
     │ A   │ │ B   │     ← A and B run in parallel
     └──┬──┘ └──┬──┘
        │       │
     ┌──▼───────▼──┐
     │   merge     │     ← merge waits for both A and B
     └─────────────┘
```

### Fork semantics

- Each branch receives the **same** input (the forking node's output).
- Each branch gets an independent **snapshot** of the shared state. State
  writes from parallel branches are merged back after all branches in the
  fork complete. Last-write-wins for conflicting keys.
- Token usage is summed across all branches.
- The `path` array records parallel nodes in the order they complete.

### Join semantics

A **join** happens when multiple edges target the same node. The target
node does not execute until **all** incoming predecessors in the current
execution have completed. The engine tracks in-degree at runtime:

```
in_degree[node_id] = number of predecessors still running
```

When `in_degree` drops to zero, the join node starts. Its input is the
concatenation of all predecessor outputs (see Section 1).

### Timeout

`RunOptions.timeout_ms` applies to the entire graph. If a parallel
branch stalls, the global timeout aborts the whole run. There is no
per-node timeout at the graph level — individual agents can set
`tool_timeout_ms` in their `AgentConfig`.

---

## 4. Loop Edges and Safe Cycle Handling

A **loop edge** is an edge from a node back to itself or to an ancestor
in the graph. Loops enable patterns like iterative refinement:

```
        ┌────────────────────┐
        │                    │
        ▼                    │  condition: needs_revision
   ┌─────────┐    ┌─────────┴──┐
   │  draft   │──>│  review     │
   └─────────┘    └──────┬─────┘
                         │  condition: approved
                      __end__
```

### Visit counter

The engine maintains a per-node visit counter for the current run:

```typescript
visits: Map<string, number>   // node_id → count
```

Before executing a node, the engine increments its counter and checks:

```
if visits.get(node_id) > max_node_visits:
    throw GraphCycleError(node_id, visits, max_node_visits)
```

`max_node_visits` defaults to **10** (mirroring `AgentConfig.max_turns`).
Callers can override it via `RunOptions.max_node_visits`.

### Why 10?

A loop that iterates more than 10 times is almost always a bug — a
condition that never becomes false, or a refinement loop that cannot
converge. The limit is deliberately low to fail fast. Legitimate
high-iteration patterns (batch processing, pagination) should be modeled
as tool calls within a single node, not as graph loops.

### Self-edges

A self-edge (`from: "A", to: "A"`) is a special case of a loop. It is
subject to the same visit counter. The node's own output becomes its next
input, and the state is re-validated between iterations. This is useful
for "try until satisfied" patterns where the same agent refines its own
output.

### Loop + parallel interaction

A loop edge inside a parallel branch only affects that branch's visit
counter. Parallel branches maintain independent visit counters (cloned
from the parent at fork time). A runaway loop in one branch will throw
`GraphCycleError` for that branch without affecting siblings.

---

## 5. Streaming Model

`TuttiGraph.stream()` returns an `AsyncIterable<GraphEvent>`. Events are
yielded in execution order:

| Event              | When                                           |
|--------------------|------------------------------------------------|
| `graph:start`      | Execution begins                               |
| `node:start`       | A node begins executing (includes its input)   |
| `node:end`         | A node completes (includes its NodeResult)     |
| `node:skip`        | A node was skipped (join not yet satisfied)     |
| `edge:evaluate`    | A condition was evaluated (includes result)     |
| `edge:traverse`    | An edge was taken                              |
| `state:update`     | Shared state was mutated after a node ran       |
| `graph:end`        | Execution complete (includes GraphRunResult)   |

For parallel branches, events from concurrent nodes are interleaved in
the order they occur (not buffered per branch). Consumers can group
events by `node_id` if they need per-branch ordering.

### Relationship to run()

`run()` is implemented on top of `stream()` — it consumes the full
iterable and returns the `GraphRunResult` from the final `graph:end`
event. This ensures identical execution semantics between the two methods.

---

## 6. Error Hierarchy

| Error                  | Code                    | When                                      |
|------------------------|-------------------------|-------------------------------------------|
| `GraphValidationError` | `GRAPH_INVALID`         | Config is structurally invalid (constructor) |
| `GraphCycleError`      | `GRAPH_CYCLE`           | Node visit count exceeds limit (runtime)  |
| `GraphStateError`      | `GRAPH_STATE_INVALID`   | State fails Zod validation after node run |
| `GraphDeadEndError`    | `GRAPH_DEAD_END`        | No outgoing edge satisfied after node run |

All extend `TuttiError` and follow the standard `{ code, message, context }`
shape. Node-level errors (provider failures, tool timeouts, guardrail
blocks) propagate unwrapped — the graph does not catch agent-level errors.

---

## 7. Invariants

1. A node never executes until all of its satisfied incoming edges have
   delivered results (join barrier).
2. The entrypoint node has no incoming edges evaluated — it always runs
   first.
3. `GraphRunResult.path` always starts with `entrypoint` and ends with
   the last node before `END`.
4. `GraphRunResult.outputs` contains exactly one entry per unique node
   that was visited. For loops, only the final iteration's result is kept.
5. Shared state mutations are serialized — even in parallel branches,
   the merge-back step is atomic.
6. The `stream()` iterable always yields `graph:start` first and
   `graph:end` last.
7. `run()` and `stream()` produce identical side effects for the same
   input and options — `run()` is `stream()` fully consumed.
