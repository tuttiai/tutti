---
"@tuttiai/server": patch
---

`POST /run/stream` and `POST /run` abort their run when the client disconnects, and `POST /run` also when it answers `504`. The run used to carry on to completion for a caller that had gone, calling tools and asking for approvals nobody would see.
