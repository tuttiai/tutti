---
"@tuttiai/core": patch
---

Break the typecheck cycle between `@tuttiai/core`'s scheduled-delivery dispatcher and the voice packages it dispatches to.

`packages/core/src/scheduler/dispatch.ts` previously typed each voice's module shape with `typeof import("@tuttiai/<voice>")`. To make those types resolvable in a fresh checkout, core would have to declare each voice (slack, discord, telegram, email, whatsapp) as a workspace devDependency. But every voice already declares `@tuttiai/core` as a peer dependency for `SecretsManager`, so the reverse edge closes a turbo build cycle and turbo refuses to order the workspace.

Fix: replace the five `typeof import("@tuttiai/<voice>")` annotations with module-local structural interfaces (`SlackVoice` / `SlackWrapper`, `DiscordVoice` / `DiscordWrapper`, etc.) describing only the surface dispatch actually calls. Runtime is unchanged — still a dynamic `import(spec)` against the real voice module. No public-API change.

Resolves the CI failure observed on `chore(release): v0.26.1 — security patch` (https://github.com/tuttiai/tutti/actions/runs/26003875482) where `tsc` and `tsup`'s dts step failed with `TS2307: Cannot find module '@tuttiai/slack' …` against five voice packages on cold checkouts.
