import type { Permission, Tool, Voice } from "@tuttiai/types";
import { createSenderClient, type SenderClient, type SenderClientOptions } from "./client.js";
import { createListGroupsTool } from "./tools/list-groups.js";
import { createListSubscribersTool } from "./tools/list-subscribers.js";
import { createGetSubscriberTool } from "./tools/get-subscriber.js";
import { createListCampaignsTool } from "./tools/list-campaigns.js";
import { createGetCampaignTool } from "./tools/get-campaign.js";
import { createCreateSubscriberTool } from "./tools/create-subscriber.js";
import { createUpdateSubscriberTool } from "./tools/update-subscriber.js";
import { createCreateGroupTool } from "./tools/create-group.js";
import { createAddSubscriberToGroupTool } from "./tools/add-subscriber-to-group.js";
import { createRemoveSubscriberFromGroupTool } from "./tools/remove-subscriber-from-group.js";
import { createCreateCampaignTool } from "./tools/create-campaign.js";
import { createSendCampaignTool } from "./tools/send-campaign.js";
import { createScheduleCampaignTool } from "./tools/schedule-campaign.js";
import { createDeleteSubscriberTool } from "./tools/delete-subscriber.js";

/** Options for {@link SenderVoice}. */
export type SenderVoiceOptions = SenderClientOptions;

/**
 * Lets agents manage a Sender (sender.net) email marketing account:
 * subscribers, groups and campaigns.
 *
 * `create_campaign` only ever creates a draft. The three tools that email
 * real people or delete data (`send_campaign`, `schedule_campaign`,
 * `delete_subscriber`) are marked `destructive: true`, so HITL-enabled
 * runtimes gate them behind human approval. Sender is stateless HTTP, so
 * {@link teardown} has nothing to release.
 */
export class SenderVoice implements Voice {
  name = "sender";
  description = "Manage Sender email marketing: subscribers, groups and campaigns";
  required_permissions: Permission[] = ["network"];
  tools: Tool[];

  private readonly client: SenderClient;

  constructor(options: SenderVoiceOptions = {}) {
    this.client = createSenderClient(options);
    this.tools = [
      createListGroupsTool(this.client),
      createListSubscribersTool(this.client),
      createGetSubscriberTool(this.client),
      createListCampaignsTool(this.client),
      createGetCampaignTool(this.client),
      createCreateSubscriberTool(this.client),
      createUpdateSubscriberTool(this.client),
      createCreateGroupTool(this.client),
      createAddSubscriberToGroupTool(this.client),
      createRemoveSubscriberFromGroupTool(this.client),
      createCreateCampaignTool(this.client),
      createSendCampaignTool(this.client),
      createScheduleCampaignTool(this.client),
      createDeleteSubscriberTool(this.client),
    ];
  }

  async teardown(): Promise<void> {
    // Stateless HTTP: nothing to close.
  }
}

export { createSenderClient, SenderClientWrapper, SENDER_BASE_URL } from "./client.js";
export type { SenderClient, SenderClientOptions, FetchLike, SenderRequest, SenderResult } from "./client.js";
export { SenderVoiceConfigSchema, type SenderVoiceConfig } from "./config-schema.js";
