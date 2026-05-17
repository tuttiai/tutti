# v0.26.0 — Self-improving skills, serverless runtime, scheduled delivery.

Three additions shape this release: a closed-loop skill-synthesis pipeline that turns observed agent trajectories into reviewable, callable tools; a serverless deploy path so a score can run as a Modal function or a warm Daytona devcontainer; and post-run delivery on scheduled agents so a nightly run becomes a Slack message, an email, or a Telegram chat without glue code.

## Self-improving skills — trajectories become tools

`@tuttiai/skills` is a new package. It holds the `SkillStore` contract, an `InMemorySkillStore` reference implementation, and the `Skill` / `SkillCandidate` / `Trajectory` data model. `@tuttiai/core` wires three coordinators around it: a `TrajectoryObserver` that records every tool call of a successful run, a `SkillProposer` that asks the score's LLM to synthesise a `SkillCandidate` from a trajectory window (with dedupe against prior candidates), and a `SkillExecutor` that projects approved skills into callable `Tool`s so the agent can invoke them like a voice tool. Permissions for a skill are the union of the constituent tools' permissions — checked at run start, not at invocation, so a permission breach fails fast. The whole loop is gated on `score.skills.enabled` and a supplied `skillStore`; with the flag off, runtime cost is zero.

```ts
skills: {
  enabled: true,
  auto_propose_threshold: 5,
}
```

Operators review candidates with the new CLI: `tutti-ai skills proposed` lists pending candidates, `tutti-ai skills review` walks them interactively (approve, edit-then-approve, reject, skip), `tutti-ai skills list` shows what's already approved, and `tutti-ai skills reject <id> --reason "..."` rejects non-interactively. Approved skills enter the next agent run as tools; rejected candidates are kept with `status: "rejected"` for audit.

## Serverless runtime — `tutti-ai deploy --target modal`

`@tuttiai/deploy` adds two new targets to the existing `docker | cloudflare | railway | fly` set. `modal` emits a Modal app: `modal_app.py` runs the Tutti Node server inside a `node:20-bookworm-slim` image, declares each `manifest.secrets` entry as `modal.Secret.from_name("tutti-<lowercase-name>")`, surfaces `manifest.env` as the function's `env=` dict, and exposes the Node server via `@modal.web_server(port=3000, startup_timeout=120)`. `daytona` emits a devcontainer bundle (`.devcontainer/devcontainer.json`, `.daytona/snapshots.yaml`, `daytona.sh`) for an always-warm agent dev environment with port 3000 forwarded and `tutti-ai@latest` pinned.

```
$ tutti-ai deploy --target modal
✓ Modal bundle written to ./.tutti/deploy
  - modal_app.py
  - tutti.score.ts
  - .env.modal.example
  - deploy.sh
Next: cd .tutti/deploy && ./deploy.sh
```

A new `tutti-ai deploy verify-hibernate` subcommand checks a score against the serverless-hibernation contract — long-lived in-memory stores, background timers outside the scheduler, anything that silently loses state when Modal hibernates the container — so a `--target modal` deploy doesn't quietly lose memory between invocations. A nightly Modal smoke workflow (`.github/workflows/modal-smoke.yml`) builds and deploys the marketing-agent example end-to-end against a real Modal account, polling `/health` for up to 240s and always tearing down with `modal app stop`.

The Daytona snapshot field names (`idle_minutes_until_hibernate`, `auto_resume`) ship with a TODO banner — they are not yet verified against the current Daytona schema and hibernation may need to migrate into `daytona sandbox create` flags in a follow-up.

## Scheduled delivery — output goes where you need it

`AgentScheduleConfig` gains an optional `deliver` target (`slack | discord | telegram | email | whatsapp`) and a `deliver_format` (`text | markdown`). After a successful scheduled run, the engine dispatches the agent's text output to the configured platform via the matching voice's shared `forToken` / `forKey` wrapper — reusing whichever client the agent already initialised. Delivery failures are absorbed in the engine (a Slack 5xx never crashes the timer) and surface as `schedule:delivery_failed` events; success surfaces as `schedule:delivered`. Missing voice packages fail fast at schedule registration with a precise "Install `@tuttiai/<platform>`" remediation error.

```ts
agents: {
  standup: {
    name: "standup",
    system_prompt: "You write a 5-bullet daily standup summary…",
    voices: [github, postgres],
    schedule: {
      cron: "0 9 * * 1-5",
      input: "Generate today's standup from the engineering channels.",
      deliver: { platform: "slack", channel: "#standup" },
      deliver_format: "markdown",
    },
  },
}
```

## Migration

Fully additive. No breaking changes. The `skills` block is opt-in; the `deliver` field is optional; new deploy targets sit alongside the existing four. Existing scores upgrade without edits.

## Known security advisories

Five npm-audit advisories are open in transitive dependencies of `@tuttiai/telemetry` (`@opentelemetry/sdk-node`, `@opentelemetry/exporter-prometheus`, `@opentelemetry/auto-instrumentations-node`, `protobufjs`, `@protobufjs/utf8`). Clearing them requires a breaking-change upgrade of the OpenTelemetry SDK and is tracked for v0.26.1 — see [SECURITY-NOTES-v0.26.0.md](../SECURITY-NOTES-v0.26.0.md) for details and impact analysis.
