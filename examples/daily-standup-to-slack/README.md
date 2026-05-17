# Daily standup to Slack

A single scheduled agent that, every weekday at 09:00, reads yesterday's
GitHub activity across your repos and posts a markdown summary to
`#engineering` on Slack. Cron triggers the run; the scheduler delivers
the agent's final reply through the `@tuttiai/slack` voice — no posting
tool is invoked from the agent itself.

## Setup

1. Install voices (already in the monorepo):

   ```bash
   npm install
   npm run build
   ```

2. Create a GitHub personal access token with `repo` and `read:org` scopes
   and export it:

   ```bash
   export GITHUB_TOKEN=ghp_...
   ```

3. Create a Slack bot user with `chat:write` (plus
   `chat:write.public` if `#engineering` is public and the bot isn't a
   member), invite it to `#engineering`, and export the token:

   ```bash
   export SLACK_BOT_TOKEN=xoxb-...
   ```

4. Anthropic provider:

   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   ```

5. Set the channel — the example targets `#engineering`. To change it,
   edit the `deliver.channel` field in `tutti.score.ts` (channel name
   with `#` prefix, or a `C0…` channel id).

## Run

Sanity check the score loads without spinning up the runtime:

```bash
npx tsx examples/daily-standup-to-slack/tutti.score.ts --check
```

Boot the scheduler and let it tick:

```bash
tutti-ai run --score examples/daily-standup-to-slack/tutti.score.ts
```

The first cron fire-time after process start is when the first post
lands; until then nothing visible happens.

## Timezone

The `schedule.cron` expression evaluates against the Node process's local
clock. Set `TZ=Europe/London` (or wherever your team works) on the
runtime before launching so 09:00 means 09:00 in their time. There is no
per-schedule `timezone` field at the moment.
