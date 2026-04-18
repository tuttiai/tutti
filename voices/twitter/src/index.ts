import type { Permission, Voice, Tool } from "@tuttiai/types";
import { createTwitterClient, type TwitterClientOptions } from "./client.js";
import { createPostTweetTool } from "./tools/post-tweet.js";
import { createPostThreadTool } from "./tools/post-thread.js";
import { createDeleteTweetTool } from "./tools/delete-tweet.js";
import { createSearchTweetsTool } from "./tools/search-tweets.js";
import { createGetTweetTool } from "./tools/get-tweet.js";
import { createListMentionsTool } from "./tools/list-mentions.js";
import { createListRepliesTool } from "./tools/list-replies.js";
import { createGetUserTool } from "./tools/get-user.js";
import { createGetTimelineTool } from "./tools/get-timeline.js";

/**
 * Options for {@link TwitterVoice}. Omit any field to fall back to the
 * matching `TWITTER_*` environment variable.
 */
export interface TwitterVoiceOptions extends TwitterClientOptions {}

/**
 * Gives agents the ability to read, post, search and manage Twitter/X
 * content. Write tools are marked `destructive: true` so HITL-enabled
 * runtimes can gate them behind human approval.
 */
export class TwitterVoice implements Voice {
  name = "twitter";
  description = "Post, read, search and manage Twitter/X content";
  required_permissions: Permission[] = ["network"];
  tools: Tool[];

  constructor(options: TwitterVoiceOptions = {}) {
    const client = createTwitterClient(options);
    this.tools = [
      createPostTweetTool(client),
      createPostThreadTool(client),
      createDeleteTweetTool(client),
      createSearchTweetsTool(client),
      createGetTweetTool(client),
      createListMentionsTool(client),
      createListRepliesTool(client),
      createGetUserTool(client),
      createGetTimelineTool(client),
    ];
  }
}

export { createTwitterClient } from "./client.js";
export type { TwitterClient, TwitterClientOptions } from "./client.js";
