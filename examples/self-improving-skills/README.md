# Self-improving skills — end-to-end

A `code-reviewer` agent that learns a `review_pr` skill after it has
done the same shape of work five times. This example shows the full
loop:

```
  TrajectoryObserver  →  SkillProposer  →  operator review  →  SkillExecutor
  records every run     proposes a       approve / reject     agent now calls
                        recurring shape  via `tutti-ai`       review_pr as one tool
```

The agent starts out orchestrating the constituent tools
(`get_pull_request`, `get_file_contents`, `comment_on_issue`, etc.)
turn by turn. By the sixth PR, the agent has a single `review_pr`
tool that replaces the entire dance.

## Score

[tutti.score.ts](./tutti.score.ts) wires one agent (`code-reviewer`)
with two voices (`@tuttiai/github`, `@tuttiai/filesystem`) and turns
`skills` on at the score level:

```ts
skills: {
  enabled: true,
  auto_propose_threshold: 3,   // demo value — production default is 5
},
```

The example exports an `InMemorySkillStore` so each CLI invocation
sees the same trajectories and candidates within one process. In
production swap this for a persistent implementation of `SkillStore`.

## Setup

```bash
# From the repo root
npm install
npm run build

# Validate the score loads (no API key required)
npx tsx examples/self-improving-skills/tutti.score.ts --check

# Required env vars for a real run
export ANTHROPIC_API_KEY=...
export GITHUB_TOKEN=...
```

## Walk-through

### a) Run the agent 5 times against different PRs

```bash
tutti-ai run --score examples/self-improving-skills/tutti.score.ts \
  -- "Review https://github.com/<owner>/<repo>/pull/1"

tutti-ai run --score examples/self-improving-skills/tutti.score.ts \
  -- "Review https://github.com/<owner>/<repo>/pull/2"

# ...and so on for PRs 3, 4, 5
```

Each run produces a successful trajectory of roughly the same shape:

```
get_pull_request → get_file_contents → get_file_contents → ... → comment_on_issue
```

The `TrajectoryObserver` records each one to the shared
`InMemorySkillStore`. After the third successful run (the threshold
we set above), the observer kicks the `SkillProposer` in the
background; the proposer asks Haiku to name and describe the shape
and writes a `SkillCandidate` named something like `review_pr`.

### b) See the candidate

```bash
tutti-ai skills proposed --score examples/self-improving-skills/tutti.score.ts
```

You should see one pending candidate:

```
Pending skill candidates (1):

  • review_pr  (code-reviewer)
    Review a pull request: fetch the diff, read each changed file,
    and post a consolidated review comment.
    constituents: get_pull_request, get_file_contents, comment_on_issue
    evidence:     5 trajectories
```

### c) Approve it

```bash
tutti-ai skills review --score examples/self-improving-skills/tutti.score.ts
```

The interactive review prints the proposed name, description,
constituents, the resolved `is_destructive` / `required_permissions`
unions, and three sample trajectories. Pick:

- `a` to approve with the synthesiser's description as the system
  prompt, or
- `e` to edit the system prompt first.

### d) Run the agent on PR #6

```bash
tutti-ai run --score examples/self-improving-skills/tutti.score.ts \
  -- "Review https://github.com/<owner>/<repo>/pull/6"
```

This time the agent has an additional tool: `review_pr`. The LLM
picks it instead of orchestrating individually. Internally, the
`SkillExecutor` runs a small inner-loop sub-agent against the
approved system prompt and the original constituent tools — the
outer agent sees a single tool call where it used to see three or
more.

`skill:invoked` fires on the runtime's event bus with the agent
name, skill id, and parent run id so subscribers can attribute the
reduced turn count to the synthesised skill.

## Integration test

The corresponding integration test
([packages/core/tests/integration/skills-loop.test.ts](../../packages/core/tests/integration/skills-loop.test.ts))
exercises this loop end-to-end with `MockLLMProvider` only — no
network, no real API keys — and asserts that:

- five successful runs land as five trajectories with
  `outcome: "success"`;
- the proposer produces exactly one candidate;
- `approveCandidate` makes the skill available;
- the sixth run sees the skill registered as a tool and invokes it.
