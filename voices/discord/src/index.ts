import type { Permission, Tool, Voice } from "@tuttiai/types";
import {
  createDiscordClient,
  type DiscordClient,
  type DiscordClientOptions,
} from "./client.js";
import { createPostMessageTool } from "./tools/post-message.js";
import { createEditMessageTool } from "./tools/edit-message.js";
import { createDeleteMessageTool } from "./tools/delete-message.js";
import { createAddReactionTool } from "./tools/add-reaction.js";
import { createListMessagesTool } from "./tools/list-messages.js";
import { createGetMessageTool } from "./tools/get-message.js";
import { createListChannelsTool } from "./tools/list-channels.js";
import { createListMembersTool } from "./tools/list-members.js";
import { createSendDmTool } from "./tools/send-dm.js";
import { createSearchMessagesTool } from "./tools/search-messages.js";
import { createGetGuildInfoTool } from "./tools/get-guild-info.js";

/** Options for {@link DiscordVoice}. */
export type DiscordVoiceOptions = DiscordClientOptions;

/**
 * Gives agents the ability to read, post and moderate Discord messages
 * via a bot account. Write tools are marked `destructive: true` so
 * HITL-enabled runtimes gate them behind human approval.
 *
 * The underlying discord.js Client is lazily logged in on the first
 * tool call and kept alive for the lifetime of the voice; call
 * {@link teardown} (or `TuttiRuntime.teardown()`) to close the gateway
 * connection cleanly on shutdown.
 */
export class DiscordVoice implements Voice {
  name = "discord";
  description = "Read, post and moderate Discord messages via a bot";
  required_permissions: Permission[] = ["network"];
  tools: Tool[];

  private readonly client: DiscordClient;

  constructor(options: DiscordVoiceOptions = {}) {
    this.client = createDiscordClient(options);
    this.tools = [
      createPostMessageTool(this.client),
      createEditMessageTool(this.client),
      createDeleteMessageTool(this.client),
      createAddReactionTool(this.client),
      createListMessagesTool(this.client),
      createGetMessageTool(this.client),
      createListChannelsTool(this.client),
      createListMembersTool(this.client),
      createSendDmTool(this.client),
      createSearchMessagesTool(this.client),
      createGetGuildInfoTool(this.client),
    ];
  }

  async teardown(): Promise<void> {
    if (this.client.kind === "ready") {
      await this.client.wrapper.destroy();
    }
  }
}

export { createDiscordClient, DiscordClientWrapper } from "./client.js";
export type {
  DiscordClient,
  DiscordClientOptions,
  DiscordClientLike,
  DiscordMessageLike,
  DiscordGuildLike,
  DiscordUserLike,
  DiscordTextChannelLike,
  DiscordGuildChannelLike,
  DiscordGuildMemberLike,
  ClientFactory,
  DiscordMessageHandler,
} from "./client.js";
