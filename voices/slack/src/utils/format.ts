/** Format a number with commas (e.g. 12345 → "12,345"). */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** Truncate a string to a max length, appending "..." if cut. */
export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + "...";
}

/** Slack ts is a string like "1700000000.123456" — convert to a Date. */
export function tsToDate(ts: string): Date {
  const seconds = Number.parseFloat(ts);
  return new Date(seconds * 1000);
}

/** Render a Slack ts as an ISO timestamp, falling back to the raw ts. */
export function formatTs(ts: string): string {
  const d = tsToDate(ts);
  return Number.isFinite(d.getTime()) ? d.toISOString() : ts;
}

/** Best-effort name for a message author — username, then bot id, then user id. */
export function authorLabel(msg: {
  user?: string;
  bot_id?: string;
  username?: string;
}): string {
  return msg.username ?? msg.user ?? msg.bot_id ?? "unknown";
}

/**
 * Format a Slack Web API error into a descriptive, user-fixable message.
 * @slack/web-api throws a `SlackApiError` (Error subclass) with a `data`
 * field whose `error` string is the documented Slack error code (e.g.
 * "channel_not_found", "not_authed", "ratelimited"). We map the common
 * ones to actionable hints and pass others through verbatim.
 */
export function slackErrorMessage(error: unknown, context?: string): string {
  const where = context ? ` for ${context}` : "";
  if (error instanceof Error) {
    const e = error as {
      data?: { error?: string; needed?: string; provided?: string };
      code?: string;
    };
    const slackCode = e.data?.error;

    if (slackCode === "not_authed" || slackCode === "invalid_auth") {
      return `Slack authentication failed${where}.\nCheck that SLACK_BOT_TOKEN is set to a valid xoxb- bot token and the app is installed in the workspace.`;
    }
    if (slackCode === "missing_scope") {
      const needed = e.data?.needed ? ` (needs scope: ${e.data.needed})` : "";
      return `Slack rejected the request${where} because the bot is missing a required OAuth scope${needed}.\nReinstall the app to the workspace after adding the scope.`;
    }
    if (slackCode === "channel_not_found") {
      return `Channel not found${where}.\nThe channel id is wrong, the channel was deleted, or the bot has not been invited to it (try /invite @your-bot in the channel).`;
    }
    if (slackCode === "user_not_found") {
      return `User not found${where}.\nThe user id is wrong or the user is not a member of this workspace.`;
    }
    if (slackCode === "not_in_channel") {
      return `Bot is not in the channel${where}.\nInvite the bot with /invite @your-bot before reading or posting.`;
    }
    if (slackCode === "message_not_found") {
      return `Message not found${where}.\nThe ts is wrong, the message was deleted, or the bot lacks history scope for that channel type.`;
    }
    if (slackCode === "cant_update_message") {
      return `Slack refused to update the message${where}.\nBots can only edit messages they posted themselves.`;
    }
    if (slackCode === "cant_delete_message") {
      return `Slack refused to delete the message${where}.\nBots can only delete messages they posted, or any message if the token has chat:write.customize.`;
    }
    if (slackCode === "ratelimited") {
      return `Slack rate limit exceeded${where}.\nSlow down and retry after the window resets (Slack returns Retry-After in seconds).`;
    }
    if (slackCode === "msg_too_long") {
      return `Message too long${where}.\nSlack rejects messages above 40,000 characters (and recommends staying under 4,000).`;
    }
    if (slackCode === "is_archived") {
      return `Channel is archived${where}.\nUnarchive it or pick a live channel before writing.`;
    }
    if (slackCode === "no_text") {
      return `Slack rejected an empty message${where}.\nProvide a non-empty text body.`;
    }

    if (slackCode) {
      return `Slack API error${where}: ${slackCode}`;
    }
    return `Slack API error${where}: ${error.message}`;
  }
  return String(error);
}
