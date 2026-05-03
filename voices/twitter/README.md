# @tuttiai/twitter

Twitter / X voice for [Tutti](https://tutti-ai.com) — gives agents the ability to post, read, search and manage tweets.

Write tools (`post_tweet`, `post_thread`, `delete_tweet`) are marked `destructive: true`, so HITL-enabled runtimes can gate them behind human approval before anything publishes.

## Install

```bash
tutti-ai add twitter
# or
npm install @tuttiai/twitter
```

## Authentication

Set the following environment variables (get credentials at [developer.x.com](https://developer.x.com)):

| Variable | Needed for | Notes |
|---|---|---|
| `TWITTER_BEARER_TOKEN` | Read-only tools | App-only bearer token |
| `TWITTER_API_KEY` | Write tools | OAuth 1.0a consumer key |
| `TWITTER_API_SECRET` | Write tools | OAuth 1.0a consumer secret |
| `TWITTER_ACCESS_TOKEN` | Write tools | OAuth 1.0a user token |
| `TWITTER_ACCESS_TOKEN_SECRET` | Write tools | OAuth 1.0a user token secret |

If OAuth 1.0a credentials are set, the voice uses them for everything (read + write). If only the bearer token is set, write tools return a clear `is_error` message instead of running.

You can also pass credentials directly to the constructor:

```ts
new TwitterVoice({
  bearer_token: "...",
  api_key: "...",
  api_secret: "...",
  access_token: "...",
  access_token_secret: "...",
});
```

## Tools

| Tool | Destructive | Description |
|---|---|---|
| `post_tweet` | yes | Publish a tweet. Optional `reply_to`, `quote_url`. |
| `post_thread` | yes | Publish a thread (≥ 2 tweets, each ≤ 280 chars). |
| `delete_tweet` | yes | Delete one of your tweets by ID. |
| `search_tweets` | no | Search recent tweets by query. `filter: 'recent' \| 'popular'`. |
| `get_tweet` | no | Fetch one tweet — text, author, likes, retweets, replies. |
| `list_mentions` | no | List tweets mentioning the authenticated user. (Requires OAuth 1.0a for user context.) |
| `list_replies` | no | List replies to a given tweet via `conversation_id:` search. |
| `get_user` | no | Fetch a user's bio, follower count, following count, tweet count. |
| `get_timeline` | no | Recent tweets by a user, or by `@me` if username omitted. |

## Example score

```ts
import { defineScore, AnthropicProvider } from "@tuttiai/core";
import { TwitterVoice } from "@tuttiai/twitter";

export default defineScore({
  provider: new AnthropicProvider(),
  agents: {
    marketing: {
      name: "marketing",
      model: "claude-sonnet-4-6",
      system_prompt:
        "You are a marketing agent. Draft tweets that match our brand voice. Never publish without explicit human approval.",
      voices: [new TwitterVoice()],
      permissions: ["network"],
    },
  },
});
```

Run it:

```bash
tutti-ai run marketing "Draft a launch announcement for the new Studio UI"
```

Because `post_tweet` is marked `destructive`, a HITL-enabled runtime pauses for approval before anything goes live.

## Links

- [Tutti](https://tutti-ai.com)
- [Voice source](https://github.com/tuttiai/tutti/tree/main/voices/twitter)
- [X Developer Portal](https://developer.x.com)

## License

Apache 2.0
