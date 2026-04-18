import { TwitterApi } from "twitter-api-v2";
import { SecretsManager } from "@tuttiai/core";

/** User-supplied credentials. Any unset field falls back to the matching env var. */
export interface TwitterClientOptions {
  /** App-only bearer token. Grants read-only access to the v2 API. */
  bearer_token?: string;
  /** OAuth 1.0a app consumer key. Required for write operations. */
  api_key?: string;
  /** OAuth 1.0a app consumer secret. Required for write operations. */
  api_secret?: string;
  /** OAuth 1.0a user access token. Required for write operations. */
  access_token?: string;
  /** OAuth 1.0a user access token secret. Required for write operations. */
  access_token_secret?: string;
}

/**
 * Result of resolving Twitter credentials. Exposed to tools so write tools
 * can refuse to run when only read credentials are configured, and so tool
 * execute() functions stay non-throwing.
 */
export type TwitterClient =
  | { kind: "ready"; api: TwitterApi; can_write: boolean }
  | { kind: "missing"; message: string };

/**
 * Resolve Twitter credentials from options (taking precedence) then env.
 * Returns `kind: "missing"` — never throws — so voice construction and
 * individual tool calls can surface the same helpful message.
 */
export function createTwitterClient(options: TwitterClientOptions = {}): TwitterClient {
  const apiKey = options.api_key ?? SecretsManager.optional("TWITTER_API_KEY");
  const apiSecret = options.api_secret ?? SecretsManager.optional("TWITTER_API_SECRET");
  const accessToken = options.access_token ?? SecretsManager.optional("TWITTER_ACCESS_TOKEN");
  const accessSecret =
    options.access_token_secret ?? SecretsManager.optional("TWITTER_ACCESS_TOKEN_SECRET");
  const bearer = options.bearer_token ?? SecretsManager.optional("TWITTER_BEARER_TOKEN");

  if (apiKey && apiSecret && accessToken && accessSecret) {
    return {
      kind: "ready",
      api: new TwitterApi({
        appKey: apiKey,
        appSecret: apiSecret,
        accessToken,
        accessSecret,
      }),
      can_write: true,
    };
  }

  if (bearer) {
    return { kind: "ready", api: new TwitterApi(bearer), can_write: false };
  }

  return {
    kind: "missing",
    message:
      "Twitter voice is not configured. Set TWITTER_BEARER_TOKEN for read-only tools, or set TWITTER_API_KEY + TWITTER_API_SECRET + TWITTER_ACCESS_TOKEN + TWITTER_ACCESS_TOKEN_SECRET for read + write. Create credentials at https://developer.x.com.",
  };
}
