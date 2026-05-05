import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TwitterApi } from "twitter-api-v2";
import type { ToolContext } from "@tuttiai/types";
import { TwitterVoice } from "../src/index.js";
import type { TwitterClient } from "../src/client.js";
import { createPostTweetTool } from "../src/tools/post-tweet.js";
import { createPostThreadTool } from "../src/tools/post-thread.js";
import { createDeleteTweetTool } from "../src/tools/delete-tweet.js";
import { createSearchTweetsTool } from "../src/tools/search-tweets.js";
import { createGetTweetTool } from "../src/tools/get-tweet.js";
import { createListMentionsTool } from "../src/tools/list-mentions.js";
import { createListRepliesTool } from "../src/tools/list-replies.js";
import { createGetUserTool } from "../src/tools/get-user.js";
import { createGetTimelineTool } from "../src/tools/get-timeline.js";
import {
  twErrorMessage,
  truncate,
  formatNumber,
  extractTweetId,
  tweetUrl,
} from "../src/utils/format.js";

const ctx: ToolContext = { session_id: "test", agent_name: "test" };

// ---------------------------------------------------------------------------
// Mock TwitterApi — only the v2 methods our tools call
// ---------------------------------------------------------------------------

interface MockV2 {
  tweet: ReturnType<typeof vi.fn>;
  tweetThread: ReturnType<typeof vi.fn>;
  deleteTweet: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  singleTweet: ReturnType<typeof vi.fn>;
  userMentionTimeline: ReturnType<typeof vi.fn>;
  userByUsername: ReturnType<typeof vi.fn>;
  userTimeline: ReturnType<typeof vi.fn>;
  me: ReturnType<typeof vi.fn>;
}

function createMockApi(): { v2: MockV2 } {
  return {
    v2: {
      tweet: vi.fn(),
      tweetThread: vi.fn(),
      deleteTweet: vi.fn(),
      search: vi.fn(),
      singleTweet: vi.fn(),
      userMentionTimeline: vi.fn(),
      userByUsername: vi.fn(),
      userTimeline: vi.fn(),
      me: vi.fn(),
    },
  };
}

function readyClient(can_write = true): TwitterClient & { api: { v2: MockV2 } } {
  // Mock only exposes the `v2` methods the tools call — `unknown`-cast keeps
  // the unsafe assertion explicit while satisfying the structural shape.
  return { kind: "ready", api: createMockApi() as unknown as TwitterApi, can_write };
}

let client: ReturnType<typeof readyClient>;

beforeEach(() => {
  client = readyClient(true);
});

// ---------------------------------------------------------------------------
// TwitterVoice
// ---------------------------------------------------------------------------

describe("TwitterVoice", () => {
  it("exposes 9 tools and required_permissions=['network']", () => {
    const voice = new TwitterVoice({ bearer_token: "fake" });
    expect(voice.name).toBe("twitter");
    expect(voice.required_permissions).toEqual(["network"]);
    expect(voice.tools).toHaveLength(9);
    const names = voice.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "delete_tweet",
        "get_timeline",
        "get_tweet",
        "get_user",
        "list_mentions",
        "list_replies",
        "post_thread",
        "post_tweet",
        "search_tweets",
      ].sort(),
    );
  });

  it("marks the three write tools as destructive", () => {
    const voice = new TwitterVoice({ bearer_token: "fake" });
    const destructive = voice.tools.filter((t) => t.destructive === true).map((t) => t.name).sort();
    expect(destructive).toEqual(["delete_tweet", "post_thread", "post_tweet"]);
  });

  it("reads options over env (can_write path)", () => {
    const voice = new TwitterVoice({
      api_key: "k",
      api_secret: "s",
      access_token: "a",
      access_token_secret: "b",
    });
    expect(voice.tools).toHaveLength(9);
  });
});

// ---------------------------------------------------------------------------
// Auth gating — missing client & read-only client
// ---------------------------------------------------------------------------

describe("auth gating", () => {
  it("post_tweet refuses when no credentials configured", async () => {
    const missing: TwitterClient = { kind: "missing", message: "Twitter voice is not configured." };
    const tool = createPostTweetTool(missing);
    const result = await tool.execute(tool.parameters.parse({ text: "hi" }), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not configured");
  });

  it("post_tweet refuses when only bearer token is set", async () => {
    const readOnly = readyClient(false);
    const tool = createPostTweetTool(readOnly);
    const result = await tool.execute(tool.parameters.parse({ text: "hi" }), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("OAuth 1.0a");
  });

  it("search_tweets works with read-only bearer", async () => {
    const readOnly = readyClient(false);
    readOnly.api.v2.search.mockResolvedValue({
      tweets: [
        {
          id: "1",
          text: "hello",
          author_id: "u1",
          public_metrics: { like_count: 5, retweet_count: 1, reply_count: 0, quote_count: 0 },
        },
      ],
      includes: { users: [{ id: "u1", username: "alice", name: "Alice" }] },
    });
    const tool = createSearchTweetsTool(readOnly);
    const result = await tool.execute(tool.parameters.parse({ query: "hello" }), ctx);
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("@alice");
  });
});

// ---------------------------------------------------------------------------
// post_tweet
// ---------------------------------------------------------------------------

describe("post_tweet", () => {
  it("posts a simple tweet and returns id + url", async () => {
    client.api.v2.tweet.mockResolvedValue({ data: { id: "1234567890", text: "hi" } });
    const tool = createPostTweetTool(client);
    const result = await tool.execute(tool.parameters.parse({ text: "hi" }), ctx);
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("1234567890");
    expect(result.content).toContain("https://x.com/i/web/status/1234567890");
    expect(client.api.v2.tweet).toHaveBeenCalledWith({ text: "hi" });
  });

  it("passes reply_to through to the API", async () => {
    client.api.v2.tweet.mockResolvedValue({ data: { id: "2", text: "reply" } });
    const tool = createPostTweetTool(client);
    await tool.execute(tool.parameters.parse({ text: "reply", reply_to: "111" }), ctx);
    expect(client.api.v2.tweet).toHaveBeenCalledWith({
      text: "reply",
      reply: { in_reply_to_tweet_id: "111" },
    });
  });

  it("extracts tweet id from a quote_url", async () => {
    client.api.v2.tweet.mockResolvedValue({ data: { id: "3", text: "quoting" } });
    const tool = createPostTweetTool(client);
    await tool.execute(
      tool.parameters.parse({
        text: "quoting",
        quote_url: "https://x.com/elonmusk/status/9876543210",
      }),
      ctx,
    );
    expect(client.api.v2.tweet).toHaveBeenCalledWith({
      text: "quoting",
      quote_tweet_id: "9876543210",
    });
  });

  it("rejects a malformed quote_url", async () => {
    const tool = createPostTweetTool(client);
    const result = await tool.execute(
      tool.parameters.parse({ text: "x", quote_url: "https://example.com/foo" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Invalid quote_url");
    expect(client.api.v2.tweet).not.toHaveBeenCalled();
  });

  it("returns is_error on API failure", async () => {
    const err = Object.assign(new Error("duplicate content"), { code: 403 });
    client.api.v2.tweet.mockRejectedValue(err);
    const tool = createPostTweetTool(client);
    const result = await tool.execute(tool.parameters.parse({ text: "x" }), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("[403]");
  });
});

// ---------------------------------------------------------------------------
// post_thread
// ---------------------------------------------------------------------------

describe("post_thread", () => {
  it("posts a thread and returns all ids", async () => {
    client.api.v2.tweetThread.mockResolvedValue([
      { data: { id: "10", text: "t1" } },
      { data: { id: "11", text: "t2" } },
      { data: { id: "12", text: "t3" } },
    ]);
    const tool = createPostThreadTool(client);
    const result = await tool.execute(
      tool.parameters.parse({ tweets: ["t1", "t2", "t3"] }),
      ctx,
    );
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("3 tweets");
    expect(result.content).toContain("10, 11, 12");
    expect(result.content).toContain("https://x.com/i/web/status/10");
  });

  it("rejects single-entry threads via Zod (min 2)", () => {
    const tool = createPostThreadTool(client);
    expect(() => tool.parameters.parse({ tweets: ["only one"] })).toThrow();
  });

  it("returns is_error on API failure", async () => {
    client.api.v2.tweetThread.mockRejectedValue(
      Object.assign(new Error("rate limited"), { code: 429 }),
    );
    const tool = createPostThreadTool(client);
    const result = await tool.execute(
      tool.parameters.parse({ tweets: ["a", "b"] }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("[429]");
    expect(result.content).toContain("rate limit");
  });
});

// ---------------------------------------------------------------------------
// delete_tweet
// ---------------------------------------------------------------------------

describe("delete_tweet", () => {
  it("confirms deletion on success", async () => {
    client.api.v2.deleteTweet.mockResolvedValue({ data: { deleted: true } });
    const tool = createDeleteTweetTool(client);
    const result = await tool.execute(tool.parameters.parse({ tweet_id: "42" }), ctx);
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("Deleted tweet 42");
  });

  it("flags an unexpected 'not deleted' response as error", async () => {
    client.api.v2.deleteTweet.mockResolvedValue({ data: { deleted: false } });
    const tool = createDeleteTweetTool(client);
    const result = await tool.execute(tool.parameters.parse({ tweet_id: "42" }), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("did not mark the tweet deleted");
  });

  it("returns is_error on API failure", async () => {
    client.api.v2.deleteTweet.mockRejectedValue(
      Object.assign(new Error("nope"), { code: 404 }),
    );
    const tool = createDeleteTweetTool(client);
    const result = await tool.execute(tool.parameters.parse({ tweet_id: "42" }), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Not found");
  });
});

// ---------------------------------------------------------------------------
// search_tweets
// ---------------------------------------------------------------------------

describe("search_tweets", () => {
  it("formats search results with author and metrics", async () => {
    client.api.v2.search.mockResolvedValue({
      tweets: [
        {
          id: "1",
          text: "interesting thing",
          author_id: "u1",
          public_metrics: { like_count: 100, retweet_count: 10, reply_count: 5, quote_count: 1 },
        },
      ],
      includes: { users: [{ id: "u1", username: "alice", name: "Alice" }] },
    });
    const tool = createSearchTweetsTool(client);
    const result = await tool.execute(
      tool.parameters.parse({ query: "thing", filter: "recent" }),
      ctx,
    );
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("@alice");
    expect(result.content).toContain("100");
    expect(result.content).toContain("interesting thing");
    expect(client.api.v2.search).toHaveBeenCalledWith(
      "thing",
      expect.objectContaining({ sort_order: "recency" }),
    );
  });

  it("maps filter=popular to relevancy", async () => {
    client.api.v2.search.mockResolvedValue({ tweets: [], includes: { users: [] } });
    const tool = createSearchTweetsTool(client);
    await tool.execute(tool.parameters.parse({ query: "x", filter: "popular" }), ctx);
    expect(client.api.v2.search).toHaveBeenCalledWith(
      "x",
      expect.objectContaining({ sort_order: "relevancy" }),
    );
  });

  it("returns a friendly message on zero results", async () => {
    client.api.v2.search.mockResolvedValue({ tweets: [], includes: { users: [] } });
    const tool = createSearchTweetsTool(client);
    const result = await tool.execute(tool.parameters.parse({ query: "xyz" }), ctx);
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("No tweets matched");
  });

  it("returns is_error on API failure", async () => {
    client.api.v2.search.mockRejectedValue(
      Object.assign(new Error("auth"), { code: 401 }),
    );
    const tool = createSearchTweetsTool(client);
    const result = await tool.execute(tool.parameters.parse({ query: "x" }), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("authentication failed");
  });
});

// ---------------------------------------------------------------------------
// get_tweet
// ---------------------------------------------------------------------------

describe("get_tweet", () => {
  it("returns full tweet details", async () => {
    client.api.v2.singleTweet.mockResolvedValue({
      data: {
        id: "42",
        text: "the answer",
        author_id: "u1",
        created_at: "2026-01-01T00:00:00Z",
        public_metrics: { like_count: 9, retweet_count: 3, reply_count: 2, quote_count: 1 },
      },
      includes: { users: [{ id: "u1", username: "deep", name: "Deep Thought" }] },
    });
    const tool = createGetTweetTool(client);
    const result = await tool.execute(tool.parameters.parse({ tweet_id: "42" }), ctx);
    expect(result.content).toContain("Tweet 42");
    expect(result.content).toContain("@deep");
    expect(result.content).toContain("Likes: 9");
    expect(result.content).toContain("the answer");
  });

  it("returns is_error when tweet not found (null data)", async () => {
    client.api.v2.singleTweet.mockResolvedValue({ data: null, includes: { users: [] } });
    const tool = createGetTweetTool(client);
    const result = await tool.execute(tool.parameters.parse({ tweet_id: "404" }), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("returns is_error on API failure", async () => {
    client.api.v2.singleTweet.mockRejectedValue(
      Object.assign(new Error("nope"), { code: 404 }),
    );
    const tool = createGetTweetTool(client);
    const result = await tool.execute(tool.parameters.parse({ tweet_id: "1" }), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("[404]");
  });
});

// ---------------------------------------------------------------------------
// list_mentions
// ---------------------------------------------------------------------------

describe("list_mentions", () => {
  it("fetches mentions for the authenticated user", async () => {
    client.api.v2.me.mockResolvedValue({ data: { id: "me1", username: "me", name: "Me" } });
    client.api.v2.userMentionTimeline.mockResolvedValue({
      tweets: [
        {
          id: "1",
          text: "@me hello",
          author_id: "u2",
          public_metrics: { like_count: 0, retweet_count: 0, reply_count: 0, quote_count: 0 },
        },
      ],
      includes: { users: [{ id: "u2", username: "bob", name: "Bob" }] },
    });
    const tool = createListMentionsTool(client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("1 mention of @me");
    expect(result.content).toContain("@bob");
  });

  it("reports no mentions when timeline is empty", async () => {
    client.api.v2.me.mockResolvedValue({ data: { id: "me", username: "me", name: "Me" } });
    client.api.v2.userMentionTimeline.mockResolvedValue({ tweets: [], includes: { users: [] } });
    const tool = createListMentionsTool(client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("No new mentions");
  });

  it("passes since_id through when provided", async () => {
    client.api.v2.me.mockResolvedValue({ data: { id: "me", username: "me", name: "Me" } });
    client.api.v2.userMentionTimeline.mockResolvedValue({ tweets: [], includes: { users: [] } });
    const tool = createListMentionsTool(client);
    await tool.execute(tool.parameters.parse({ since_id: "999" }), ctx);
    expect(client.api.v2.userMentionTimeline).toHaveBeenCalledWith(
      "me",
      expect.objectContaining({ since_id: "999" }),
    );
  });

  it("returns is_error on API failure", async () => {
    client.api.v2.me.mockRejectedValue(Object.assign(new Error("fail"), { code: 401 }));
    const tool = createListMentionsTool(client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("authentication failed");
  });
});

// ---------------------------------------------------------------------------
// list_replies
// ---------------------------------------------------------------------------

describe("list_replies", () => {
  it("finds replies via conversation_id search", async () => {
    client.api.v2.search.mockResolvedValue({
      tweets: [
        {
          id: "r1",
          text: "good point",
          author_id: "u1",
          public_metrics: { like_count: 2, retweet_count: 0, reply_count: 0, quote_count: 0 },
        },
      ],
      includes: { users: [{ id: "u1", username: "alice", name: "Alice" }] },
    });
    const tool = createListRepliesTool(client);
    const result = await tool.execute(
      tool.parameters.parse({ tweet_id: "42" }),
      ctx,
    );
    expect(result.content).toContain("1 reply to tweet 42");
    expect(client.api.v2.search).toHaveBeenCalledWith(
      "conversation_id:42",
      expect.anything(),
    );
  });

  it("reports no replies when search is empty", async () => {
    client.api.v2.search.mockResolvedValue({ tweets: [], includes: { users: [] } });
    const tool = createListRepliesTool(client);
    const result = await tool.execute(tool.parameters.parse({ tweet_id: "42" }), ctx);
    expect(result.content).toContain("No replies found");
  });

  it("returns is_error on API failure", async () => {
    client.api.v2.search.mockRejectedValue(new Error("timeout"));
    const tool = createListRepliesTool(client);
    const result = await tool.execute(tool.parameters.parse({ tweet_id: "1" }), ctx);
    expect(result.is_error).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// get_user
// ---------------------------------------------------------------------------

describe("get_user", () => {
  it("returns formatted user profile", async () => {
    client.api.v2.userByUsername.mockResolvedValue({
      data: {
        id: "u1",
        username: "jack",
        name: "Jack",
        description: "just setting up my twttr",
        verified: true,
        created_at: "2006-03-21T00:00:00Z",
        public_metrics: {
          followers_count: 6500000,
          following_count: 4000,
          tweet_count: 32000,
          listed_count: 50000,
        },
      },
    });
    const tool = createGetUserTool(client);
    const result = await tool.execute(tool.parameters.parse({ username: "jack" }), ctx);
    expect(result.content).toContain("@jack");
    expect(result.content).toContain("Jack");
    expect(result.content).toContain("6,500,000");
    expect(result.content).toContain("just setting up my twttr");
  });

  it("strips a leading @ from the input", async () => {
    client.api.v2.userByUsername.mockResolvedValue({
      data: { id: "u1", username: "alice", name: "Alice" },
    });
    const tool = createGetUserTool(client);
    await tool.execute(tool.parameters.parse({ username: "@alice" }), ctx);
    expect(client.api.v2.userByUsername).toHaveBeenCalledWith("alice", expect.anything());
  });

  it("returns is_error when user not found", async () => {
    client.api.v2.userByUsername.mockResolvedValue({ data: null });
    const tool = createGetUserTool(client);
    const result = await tool.execute(tool.parameters.parse({ username: "ghost" }), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("returns is_error on API failure", async () => {
    client.api.v2.userByUsername.mockRejectedValue(
      Object.assign(new Error("forbid"), { code: 403 }),
    );
    const tool = createGetUserTool(client);
    const result = await tool.execute(tool.parameters.parse({ username: "x" }), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("forbade");
  });
});

// ---------------------------------------------------------------------------
// get_timeline
// ---------------------------------------------------------------------------

describe("get_timeline", () => {
  it("fetches by username when provided", async () => {
    client.api.v2.userByUsername.mockResolvedValue({
      data: { id: "u1", username: "alice", name: "Alice" },
    });
    client.api.v2.userTimeline.mockResolvedValue({
      tweets: [
        {
          id: "1",
          text: "tweet one",
          author_id: "u1",
          public_metrics: { like_count: 1, retweet_count: 0, reply_count: 0, quote_count: 0 },
        },
      ],
    });
    const tool = createGetTimelineTool(client);
    const result = await tool.execute(tool.parameters.parse({ username: "alice" }), ctx);
    expect(result.content).toContain("from @alice");
    expect(result.content).toContain("tweet one");
    expect(client.api.v2.userTimeline).toHaveBeenCalledWith("u1", expect.anything());
  });

  it("falls back to self via me() when no username given", async () => {
    client.api.v2.me.mockResolvedValue({ data: { id: "me", username: "selfie", name: "Me" } });
    client.api.v2.userTimeline.mockResolvedValue({ tweets: [] });
    const tool = createGetTimelineTool(client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("@selfie");
    expect(client.api.v2.me).toHaveBeenCalled();
  });

  it("refuses self-timeline on read-only client", async () => {
    const readOnly = readyClient(false);
    const tool = createGetTimelineTool(readOnly);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("OAuth 1.0a");
  });

  it("allows username timeline on read-only client", async () => {
    const readOnly = readyClient(false);
    readOnly.api.v2.userByUsername.mockResolvedValue({
      data: { id: "u1", username: "alice", name: "Alice" },
    });
    readOnly.api.v2.userTimeline.mockResolvedValue({ tweets: [] });
    const tool = createGetTimelineTool(readOnly);
    const result = await tool.execute(tool.parameters.parse({ username: "alice" }), ctx);
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("@alice");
  });

  it("returns is_error when user not found", async () => {
    client.api.v2.userByUsername.mockResolvedValue({ data: null });
    const tool = createGetTimelineTool(client);
    const result = await tool.execute(tool.parameters.parse({ username: "ghost" }), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// format / render utilities
// ---------------------------------------------------------------------------

describe("format utilities", () => {
  it("twErrorMessage handles 401", () => {
    expect(twErrorMessage(Object.assign(new Error("x"), { code: 401 }))).toContain(
      "authentication failed",
    );
  });
  it("twErrorMessage handles 403", () => {
    expect(twErrorMessage(Object.assign(new Error("x"), { code: 403 }))).toContain(
      "forbade",
    );
  });
  it("twErrorMessage handles 404", () => {
    expect(twErrorMessage(Object.assign(new Error("x"), { code: 404 }))).toContain("Not found");
  });
  it("twErrorMessage handles 429", () => {
    expect(twErrorMessage(Object.assign(new Error("x"), { code: 429 }))).toContain("rate limit");
  });
  it("twErrorMessage includes detail from err.data.detail", () => {
    const err = Object.assign(new Error("Bad"), { data: { detail: "specifics" } });
    expect(twErrorMessage(err)).toContain("specifics");
  });
  it("twErrorMessage handles generic Error", () => {
    expect(twErrorMessage(new Error("boom"))).toContain("boom");
  });
  it("twErrorMessage handles non-Error", () => {
    expect(twErrorMessage("string error")).toBe("string error");
  });
  it("truncate cuts long strings", () => {
    expect(truncate("abcdefghij", 7)).toBe("abcd...");
  });
  it("truncate preserves short strings", () => {
    expect(truncate("abc", 10)).toBe("abc");
  });
  it("formatNumber adds commas", () => {
    expect(formatNumber(12345)).toBe("12,345");
  });
  it("extractTweetId parses x.com urls", () => {
    expect(extractTweetId("https://x.com/jack/status/12345")).toBe("12345");
  });
  it("extractTweetId parses twitter.com urls", () => {
    expect(extractTweetId("https://twitter.com/jack/status/67890")).toBe("67890");
  });
  it("extractTweetId returns null for non-tweet urls", () => {
    expect(extractTweetId("https://example.com/foo")).toBeNull();
  });
  it("tweetUrl builds the x.com permalink", () => {
    expect(tweetUrl("123")).toBe("https://x.com/i/web/status/123");
  });
});
