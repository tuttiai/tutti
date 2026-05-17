# @tuttiai/deploy

## 0.2.0

### Minor Changes

- 734010d: Add Daytona as a deploy target — `tutti-ai deploy --target daytona` (or `target: "daytona"` in the score) generates a devcontainer bundle (`.devcontainer/devcontainer.json`, `.daytona/snapshots.yaml`, `.gitignore`, `daytona.sh`) for an always-warm agent dev environment. Forwards port 3000, pins `tutti-ai@latest`, runs `daytona create --no-ide` followed by `daytona ssh -- tutti-ai serve …`.

  Note: the `.daytona/snapshots.yaml` field names (`idle_minutes_until_hibernate`, `auto_resume`) are not verified against the current Daytona schema and the file ships with a TODO banner — hibernation may need to move into `daytona sandbox create` flags in a follow-up.

- v0.26.0 — Self-improving skills, serverless runtime, scheduled delivery.

  Skills: `@tuttiai/skills` (new package, 0.1.0) ships the `SkillStore` contract and `InMemorySkillStore` reference. `@tuttiai/core` wires a closed loop around it — `TrajectoryObserver` records every tool call of a successful run, `SkillProposer` asks the score's LLM to synthesise a `SkillCandidate` from a trajectory window with dedupe against prior candidates, `SkillExecutor` projects approved skills into callable tools so the agent invokes them like a voice tool. Permissions for a skill are the union of constituent tools' permissions — checked at run start, not invocation. Gated on `score.skills.enabled` + a supplied `skillStore`; zero runtime cost when off. New events: `skill:candidate_proposed`, `skill:approved`, `skill:rejected`, `skill:invoked`, `skill:trajectory_observed`. CLI surface: `tutti-ai skills list | proposed | review [id] | reject <id> --reason`.

  Serverless runtime: `@tuttiai/deploy` adds `modal` and `daytona` to `DeployTarget`. Modal bundles emit `modal_app.py` running the Tutti Node server inside `node:20-bookworm-slim`, declaring `manifest.secrets` as `modal.Secret.from_name("tutti-<lowercase>")`, surfacing `manifest.env` as `env=`, exposing via `@modal.web_server(port=3000, startup_timeout=120)`. Daytona bundles emit a devcontainer + `.daytona/snapshots.yaml` + `daytona.sh` for always-warm agent envs. New CLI: `tutti-ai deploy verify-hibernate` checks scores against the serverless-hibernation contract. Nightly Modal smoke workflow polls `/health` end-to-end and tears down with `modal app stop`.

  Scheduled delivery: `AgentScheduleConfig` gains optional `deliver` (slack/discord/telegram/email/whatsapp) and `deliver_format` (text/markdown). After each successful scheduled run the engine dispatches the agent's output through the matching voice's shared `forToken` / `forKey` wrapper. Delivery failures are absorbed (`schedule:delivery_failed`) and never crash the timer; success fires `schedule:delivered`. Missing voice packages fail fast at schedule registration with a precise "Install `@tuttiai/<platform>`" error.

  Migration: fully additive — no breaking changes. The `skills` block is opt-in, the `deliver` field is optional, new deploy targets sit alongside the existing four.

  Known: five npm-audit advisories (4 high, 1 moderate) in transitive deps of `@tuttiai/telemetry` (OpenTelemetry SDK / protobufjs chain). Documented in `SECURITY-NOTES-v0.26.0.md`. Clearing them requires an OpenTelemetry SDK breaking-change upgrade, scheduled for v0.26.1.

### Patch Changes

- Updated dependencies [91a045e]
- Updated dependencies
  - @tuttiai/types@0.13.0
  - @tuttiai/core@0.23.0

## 0.1.0

### Minor Changes

- Add one-command deploy targeting Docker, Railway, and Fly.io with secrets validation, env var scanning, and deploy.sh generation

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @tuttiai/core@0.20.1
  - @tuttiai/types@0.11.1
