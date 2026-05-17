---
"@tuttiai/deploy": minor
"@tuttiai/cli": minor
---

Add Daytona as a deploy target — `tutti-ai deploy --target daytona` (or `target: "daytona"` in the score) generates a devcontainer bundle (`.devcontainer/devcontainer.json`, `.daytona/snapshots.yaml`, `.gitignore`, `daytona.sh`) for an always-warm agent dev environment. Forwards port 3000, pins `tutti-ai@latest`, runs `daytona create --no-ide` followed by `daytona ssh -- tutti-ai serve …`.

Note: the `.daytona/snapshots.yaml` field names (`idle_minutes_until_hibernate`, `auto_resume`) are not verified against the current Daytona schema and the file ships with a TODO banner — hibernation may need to move into `daytona sandbox create` flags in a follow-up.
