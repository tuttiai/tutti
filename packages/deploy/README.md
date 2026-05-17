# @tuttiai/deploy

Deploy a [Tutti](https://tutti-ai.com) score as a runnable container, Cloudflare Worker, Railway service, or Fly Machine. Bundles the `@tuttiai/server` runtime so the resulting artefact serves your agent over HTTP out of the box.

```bash
npm install @tuttiai/deploy
```

Peer dependencies: `@tuttiai/core`, `@tuttiai/types`.

## Quick start

Declare a `deploy` block on the agent you want to ship:

```typescript
import { defineScore, AnthropicProvider } from "@tuttiai/core";

export default defineScore({
  provider: new AnthropicProvider(),
  agents: {
    api: {
      name: "api",
      system_prompt: "You are helpful.",
      voices: [],
      deploy: {
        target: "fly",
        region: "ams",
        secrets: ["ANTHROPIC_API_KEY"],
        scale: { minInstances: 1, maxInstances: 5, memory: "512mb" },
      },
    },
  },
});
```

Then resolve it into a manifest:

```typescript
import { buildDeployManifest } from "@tuttiai/deploy";

const manifest = await buildDeployManifest("./tutti.score.ts");
// manifest.target          === "fly"
// manifest.name             === "api"           // inferred from agent name
// manifest.region           === "ams"
// manifest.scale.minInstances === 1
// manifest.healthCheck.path === "/health"       // default applied
```

## Validation

`buildDeployManifest` runs the standard score validator first, then layers on:

- The `deploy` block must match `DeployConfigSchema` — known `target`, kebab-case `name`, POSIX-shaped env / secret names, sane `scale` bounds, well-formed `memory` (e.g. `512mb`, `1gb`).
- Exactly one agent in the score may declare `deploy`.
- `env` keys and `secrets` entries must be disjoint.
- `env` values must not look like API keys — those go in `secrets`.

## Targets

| target | artefact |
|---|---|
| `docker` | `Dockerfile` + image build context |
| `cloudflare` | Cloudflare Worker bundle (wrangler-compatible) |
| `railway` | Railway service config (`railway.json`) |
| `fly` | Fly Machine config (`fly.toml`) |

The bundlers themselves are not yet implemented — this package currently provides the manifest contract that bundlers will consume.

## Hibernation contract

Serverless targets (`modal`, `fly` with auto-stop, future cloud-function bundlers) freeze the Tutti process between invocations. A score is *hibernation-safe* when every piece of state the runtime needs to keep working lives in a store that survives the freeze.

Run `tutti-ai deploy verify-hibernate` (see `@tuttiai/cli`) to audit a score against this contract before deploying.

### What survives hibernation

Anything written to a durable store before the freeze:

- **Checkpoints** — `agents.<name>.durable: { store: "postgres" | "redis" }`. Persisted at every turn boundary, used to resume a run after cold start.
- **Session memory** — `memory: { provider: "postgres" | "redis", url: ... }`. Per-conversation message history.
- **User memory + user model** — backed by the same `memory.provider`. The consolidator reads accumulated `UserMemory` entries from that store, so the rolling profile is durable iff the store is durable.
- **Skill trajectories** — when `skills.enabled` and the `TuttiRuntime` is constructed with a non-`InMemorySkillStore`.

### What gets reconstructed

The current run resumes from its last checkpoint via `DurableExecution` (v0.18). Cold-start sequence:

1. Process boots, instantiates the stores declared in the score.
2. Each store opens its connection to the durable backend (Postgres / Redis).
3. On the next incoming request, the runtime loads the most recent `Checkpoint` for the session and replays from there.

The `verify-hibernate` command prints an estimated sum of typical reconnect latencies as a rough cold-start budget. Real numbers depend on the platform and region.

### What is lost

- In-flight tool calls that did not write a checkpoint mid-call. Voices that declare `restorable_state: true` opt in to checkpointing their in-progress tool state; voices that omit it lose tool-call progress when the process freezes mid-call.
- `EventBus` listeners with unflushed events.
- Anything held in a process-local variable or `InMemory*` store.

Treat every `InMemory*` store as ephemeral — local development only. Never deploy a score with `memory.provider: "in-memory"` or `durable: { store: "memory" }` to a serverless target.

### Choosing a target

| target | when to use |
|---|---|
| `docker` | Always-on services. Hibernation is a non-issue — the process never freezes. |
| `modal` | Bursty workloads. Pay per-invocation; cold starts are frequent, so the hibernation contract must hold. |
| `daytona` | Dev / staging. Workspaces sleep but their disk persists, so in-memory state survives for individual users. |
| `fly` | Always-on with edge regions. Enable auto-stop only after `verify-hibernate` passes. |

## Modal — local setup

The `modal` target generates a `modal_app.py` bundle that uses
`@modal.web_server` to proxy traffic to the Tutti Node server. To deploy it
locally:

1. **Install the Modal CLI** (requires Python 3.9+):

   ```bash
   pip install modal
   ```

2. **Create a Modal account** at https://modal.com — the free tier is enough
   for the CI smoke (one short-lived `tutti-smoke` app per run).

3. **Authenticate the CLI**. Either of:

   ```bash
   modal token new                                    # interactive browser flow
   ```

   ...or set the token pair as environment variables (the form CI uses):

   ```bash
   export MODAL_TOKEN_ID="ak-xxxxxxxxxxxxxxxxxxxxxx"
   export MODAL_TOKEN_SECRET="as-xxxxxxxxxxxxxxxxxxxxxx"
   ```

   Generate the pair from https://modal.com/settings/tokens.

4. **Provision the secrets your score declares.** For each entry in
   `deploy.secrets`, create a Modal secret named `tutti-<lowercase-name>`:

   ```bash
   modal secret create tutti-anthropic-api-key ANTHROPIC_API_KEY="sk-ant-..."
   ```

5. **Generate and deploy the bundle:**

   ```bash
   tutti-ai deploy --target modal --out-dir .tutti/modal-smoke
   cd .tutti/modal-smoke
   modal deploy modal_app.py
   ```

   Tear down the app with `modal app stop <name>` (the name comes from
   `deploy.name` or the agent key).

### CI smoke

`.github/workflows/modal-smoke.yml` runs this same flow against the
`examples/marketing-agent` score on every push to `main`, nightly at
06:00 UTC, and on PRs labeled `deploy-smoke`. The label is auto-applied
by `.github/workflows/deploy-smoke-label.yml` to any PR touching this
package's `targets/modal.ts`.

Required repo secrets:

| secret | source |
|---|---|
| `MODAL_TOKEN_ID` | https://modal.com/settings/tokens |
| `MODAL_TOKEN_SECRET` | same page — shown once at creation |
| `ANTHROPIC_API_KEY` | provider key the deployed agent will use |

The smoke skips cleanly when any of these is missing — PRs from forks
(where secrets are unavailable by design) therefore never fail this job.

## License

Apache-2.0
