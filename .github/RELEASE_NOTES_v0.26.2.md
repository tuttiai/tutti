## v0.26.2 — Fix CI build cycle in scheduled-delivery dispatcher.

v0.26.2 fixes a pre-existing typecheck / build failure that the
scheduled-delivery work in v0.26.0 introduced and that surfaced on the
v0.26.1 release commit: every CI run since v0.26.0 failed with
`TS2307: Cannot find module '@tuttiai/slack' …` against five voice
packages on cold checkouts.

No new features, no runtime behaviour change. Drop-in for any v0.26.x
install. Recommended for anyone running the project's own CI.

## Failure

`packages/core/src/scheduler/dispatch.ts` typed each voice's module
shape with `typeof import("@tuttiai/<voice>")`. On a cold checkout the
voice `.d.ts` files do not exist until each voice's `build` task runs —
but core never declared the voices as workspace dependencies, so turbo
had no edge that would order voice builds before core typecheck. CI
(`actions/runs/26003875482`) failed in `security`, `typecheck`, and
`test` jobs with the same five `TS2307` errors against
`@tuttiai/slack`, `@tuttiai/discord`, `@tuttiai/telegram`,
`@tuttiai/email`, `@tuttiai/whatsapp`.

The natural fix — add voices as devDeps of core — closes a build cycle
because every voice already imports `SecretsManager` from
`@tuttiai/core`. That cycle is the same one
[`0803dfe`](https://github.com/tuttiai/tutti/commit/0803dfe) broke for
`@tuttiai/skills` in v0.26.0.

## Fix

Replace the five module-level type imports in `dispatch.ts` with
file-local structural interfaces (`SlackVoice` / `SlackWrapper`,
`DiscordVoice` / `DiscordWrapper`, `TelegramVoice` / `TelegramWrapper`,
`EmailVoice` / `EmailWrapper`, `WhatsAppVoice` / `WhatsAppWrapper`)
describing only the surface dispatch actually calls. Each interface is
under 10 lines and lives next to the function that uses it.

Runtime is unchanged. The dispatcher still calls
`importFn("@tuttiai/<voice>")` and uses the real exported wrapper
class; only the type surface is now local. The `engine-delivery`
integration tests still cover every platform's send path, so a
divergence between these structural types and the real voice export
would surface there.

## Bumps

| Package | v0.26.1 | v0.26.2 |
|---|---|---|
| `@tuttiai/core` | 0.23.1 | **0.23.2** |
| All other packages | unchanged | unchanged |

`@tuttiai/telemetry@0.4.1` (security patch from v0.26.1) is unchanged
in v0.26.2.

## Compatibility

No public-API change; no migration required.

## Verifying the fix locally

```
npm install @tuttiai/core@0.23.2
npx turbo run build typecheck test
# expected: all tasks green on a cold checkout
```
