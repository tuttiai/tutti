/**
 * Daily standup to Slack — scheduled cron + scheduler delivery.
 *
 * A single agent ("standup-bot") wakes up Monday–Friday at 09:00, asks the
 * GitHub voice to summarise the team's yesterday across PRs and issues,
 * and the scheduler delivers the agent's final markdown reply to a Slack
 * channel via the `@tuttiai/slack` voice's token-keyed client.
 *
 * Quick check (no run):
 *   npx tsx examples/daily-standup-to-slack/tutti.score.ts --check
 *
 * Boot the scheduler:
 *   tutti-ai run --score examples/daily-standup-to-slack/tutti.score.ts
 */

import { AnthropicProvider, defineScore } from "@tuttiai/core";
import { GitHubVoice } from "@tuttiai/github";
import { SlackVoice } from "@tuttiai/slack";

// `schedule.cron` is interpreted in the scheduler process's local time
// (the Node runtime's TZ). Set TZ=Europe/London at the runtime level if
// you need a fixed business-hours window — the score-level schedule
// schema does not yet carry a per-agent timezone field.
const score = defineScore({
  provider: new AnthropicProvider(),
  entry: "standup-bot",

  agents: {
    "standup-bot": {
      name: "Standup Bot",
      role: "specialist",
      model: "claude-sonnet-4-6",
      permissions: ["network"],
      voices: [new GitHubVoice(), new SlackVoice()],
      budget: { max_cost_usd: 0.1 },
      schedule: {
        cron: "0 9 * * 1-5",
        input:
          "Summarise yesterday's PRs and issues across the team. Group by repo, " +
          "include PR title + author + state, and flag anything still awaiting review.",
        deliver: { platform: "slack", channel: "#engineering" },
        deliver_format: "markdown",
      },
      system_prompt: `You are the team's daily standup bot.

Every weekday morning you receive an input asking for a "yesterday" summary
across the team's repositories. Use the GitHub voice's read-only tools
(list_pull_requests, list_issues, get_pull_request, list_repositories) to
gather data. Filter to events from the previous calendar day in UTC.

Output rules:
  - Use markdown. Group by repository as level-3 headings.
  - For each repo, list merged PRs, then open PRs awaiting review, then
    issues opened or closed yesterday. Skip sections with no activity.
  - Tag each PR with author and current state. Highlight PRs sitting in
    review for more than 48 hours with a leading "⏰".
  - Keep the whole post under 1500 characters — Slack truncates long
    messages and people stop reading.
  - Do NOT post directly. Return the markdown as your final reply; the
    scheduler delivers it to #engineering for you.`,
    },
  },
});

export default score;

// ---------------------------------------------------------------------------
// Quick sanity check — `npx tsx tutti.score.ts --check`
// ---------------------------------------------------------------------------

if (process.argv.includes("--check")) {
  const summary = {
    entry: score.entry,
    agents: Object.entries(score.agents).map(([id, a]) => ({
      id,
      name: a.name,
      voices: a.voices.map((v) => v.name),
      schedule: a.schedule,
    })),
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  process.exit(0);
}
