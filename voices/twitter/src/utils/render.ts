import type { TweetV2, UserV2 } from "twitter-api-v2";
import { formatNumber, truncate, tweetUrl } from "./format.js";

/** One-line label for a user, using the includes array when available. */
function authorLabel(tweet: TweetV2, users: UserV2[]): string {
  const match = users.find((u) => u.id === tweet.author_id);
  if (match) return `@${match.username}`;
  return tweet.author_id ? `user ${tweet.author_id}` : "unknown";
}

/** Render a tweet as a compact multi-line block for list output. */
export function formatTweetLine(tweet: TweetV2, users: UserV2[]): string {
  const metrics = tweet.public_metrics;
  const stats = metrics
    ? ` | ${formatNumber(metrics.like_count)} ❤ · ${formatNumber(metrics.retweet_count)} ↻ · ${formatNumber(metrics.reply_count)} 💬`
    : "";
  return [
    `${authorLabel(tweet, users)}${stats}`,
    truncate(tweet.text, 200),
    tweetUrl(tweet.id),
  ].join("\n");
}

/** Render a single tweet's full detail block. */
export function formatTweetBlock(tweet: TweetV2, users: UserV2[]): string {
  const metrics = tweet.public_metrics;
  const lines = [
    `Tweet ${tweet.id}`,
    `Author: ${authorLabel(tweet, users)}`,
    tweet.created_at ? `Created: ${tweet.created_at}` : null,
    metrics
      ? `Likes: ${formatNumber(metrics.like_count)} | Retweets: ${formatNumber(metrics.retweet_count)} | Replies: ${formatNumber(metrics.reply_count)} | Quotes: ${formatNumber(metrics.quote_count)}`
      : null,
    `URL: ${tweetUrl(tweet.id)}`,
    "",
    tweet.text,
  ].filter((l): l is string => l !== null);
  return lines.join("\n");
}

/** Render a user profile as a multi-line block. */
export function formatUserBlock(user: UserV2): string {
  const m = user.public_metrics;
  const lines = [
    `@${user.username} — ${user.name}`,
    user.verified ? "Verified: yes" : null,
    user.location ? `Location: ${user.location}` : null,
    m
      ? `Followers: ${formatNumber(m.followers_count ?? 0)} | Following: ${formatNumber(m.following_count ?? 0)} | Tweets: ${formatNumber(m.tweet_count ?? 0)} | Listed: ${formatNumber(m.listed_count ?? 0)}`
      : null,
    user.created_at ? `Joined: ${user.created_at}` : null,
    "",
    user.description || "(no bio)",
  ].filter((l): l is string => l !== null);
  return lines.join("\n");
}
