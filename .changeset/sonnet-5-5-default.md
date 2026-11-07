---
"@tuttiai/core": patch
"@tuttiai/server": patch
---

Agents with no model set, and the server image without `TUTTI_MODEL`, now default to `claude-sonnet-5-5` instead of the retired `claude-sonnet-4-20250514`. An explicit model is still used as given.
