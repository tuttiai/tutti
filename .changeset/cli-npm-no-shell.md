---
"@tuttiai/cli": patch
---

`tutti-ai add`, `outdated` and `upgrade` validate package names before calling npm and run it without a shell, closing a command-injection path through crafted names.
