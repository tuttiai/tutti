# @tuttiai/skills

Agent-callable skills synthesised from observed trajectories.

A **trajectory** is the recorded tool-call sequence of one agent run. When the
same trajectory shape recurs across runs, a future synthesiser proposes a
**skill candidate** — a name, description, signature, and the list of
constituent tools. An operator approves or rejects the candidate; approved
candidates become **skills** that the agent can call directly.

This v0.1 package ships only the storage and review primitives:

- `Trajectory` / `TrajectoryToolCall` — recorded run shapes
- `SkillCandidate` / `Skill` — proposal and approval states
- `SkillStore` — interface for trajectory + candidate + skill persistence
- `InMemorySkillStore` — reference implementation, suitable for tests and
  single-process deployments

The candidate synthesiser, the runtime adapter that exposes approved skills as
tools, and persistent backends are out of scope for v0.1.

## Event emission

If constructed with an `EventBus`, `InMemorySkillStore` emits:

- `skill:candidate_proposed` — on `proposeCandidate`
- `skill:approved` — on `approveCandidate`
- `skill:rejected` — on `rejectCandidate`

`recordTrajectory` does not emit — trajectories are append-only observability.

## Quick start

```typescript
import { InMemorySkillStore } from "@tuttiai/skills";
import { EventBus } from "@tuttiai/core";

const bus = new EventBus();
const store = new InMemorySkillStore({ events: bus });

bus.on("skill:candidate_proposed", (e) => {
  console.log(`new candidate: ${e.name_suggestion} (${e.evidence_count} runs)`);
});

await store.recordTrajectory(trajectory);
await store.proposeCandidate(candidate);
await store.approveCandidate(candidate.id, { reviewed_by: "alice" });
```
