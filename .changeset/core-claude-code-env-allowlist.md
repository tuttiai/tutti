---
"@tuttiai/core": patch
---

Start the Claude Code CLI with an allowlisted environment (paths, locale, proxy and TLS settings, and the CLI's own login and config variables) plus `invocation.env`, instead of the whole server environment. Variables not on the list, such as `TUTTI_PG_URL`, other provider keys and `AWS_*`, no longer reach the CLI.
