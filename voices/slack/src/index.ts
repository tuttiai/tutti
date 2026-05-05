import type { Permission, Tool, Voice } from "@tuttiai/types";
import {
  createSlackClient,
  type SlackClient,
  type SlackClientOptions,
} from "./client.js";
import { createPostMessageTool } from "./tools/post-message.js";
import { createUpdateMessageTool } from "./tools/update-message.js";
import { createDeleteMessageTool } from "./tools/delete-message.js";
import { createAddReactionTool } from "./tools/add-reaction.js";
import { createListMessagesTool } from "./tools/list-messages.js";
import { createGetMessageTool } from "./tools/get-message.js";
import { createListChannelsTool } from "./tools/list-channels.js";
import { createListMembersTool } from "./tools/list-members.js";
import { createSendDmTool } from "./tools/send-dm.js";
import { createSearchMessagesTool } from "./tools/search-messages.js";
import { createGetWorkspaceInfoTool } from "./tools/get-workspace-info.js";

/** Options for {@link SlackVoice}. */
export type SlackVoiceOptions = SlackClientOptions;

/**
 * Gives agents the ability to read, post and moderate Slack messages
 * via a bot user token (`xoxb-`). Write tools are marked
 * `destructive: true` so HITL-enabled runtimes gate them behind human
 * approval.
 *
 * The underlying @slack/web-api WebClient is created lazily on the first
 * tool call. Slack's WebClient is stateless HTTP, so {@link teardown} is
 * a cache clear rather than a connection close — but it is still safe to
 * call on shutdown.
 */
export class SlackVoice implements Voice {
  name = "slack";
  description = "Read, post and moderate Slack messages via a bot token";
  required_permissions: Permission[] = ["network"];
  tools: Tool[];

  private readonly client: SlackClient;

  constructor(options: SlackVoiceOptions = {}) {
    this.client = createSlackClient(options);
    this.tools = [
      createPostMessageTool(this.client),
      createUpdateMessageTool(this.client),
      createDeleteMessageTool(this.client),
      createAddReactionTool(this.client),
      createListMessagesTool(this.client),
      createGetMessageTool(this.client),
      createListChannelsTool(this.client),
      createListMembersTool(this.client),
      createSendDmTool(this.client),
      createSearchMessagesTool(this.client),
      createGetWorkspaceInfoTool(this.client),
    ];
  }

  async teardown(): Promise<void> {
    if (this.client.kind === "ready") {
      await this.client.wrapper.destroy();
    }
  }
}

export { createSlackClient, SlackClientWrapper } from "./client.js";
export type {
  SlackClient,
  SlackClientOptions,
  SlackClientLike,
  SlackMessageLike,
  SlackConversationLike,
  SlackUserLike,
  SlackTeamLike,
  ClientFactory,
} from "./client.js";
