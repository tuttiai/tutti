/** Format a number with commas (e.g. 12345 → "12,345"). */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** Truncate a string to a max length, appending "..." if cut. */
export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + "...";
}

/** Build a clickable Discord message permalink. */
export function messageUrl(
  guild_id: string | null | undefined,
  channel_id: string,
  message_id: string,
): string {
  const scope = guild_id ?? "@me";
  return `https://discord.com/channels/${scope}/${channel_id}/${message_id}`;
}

/**
 * Format a discord.js error into a descriptive, user-fixable message.
 * The library throws `DiscordAPIError` with a numeric `code` and `status`.
 */
export function discordErrorMessage(error: unknown, context?: string): string {
  const where = context ? ` for ${context}` : "";
  if (error instanceof Error) {
    const e = error as { code?: number | string; status?: number; rawError?: { message?: string } };
    const status = e.status;
    const statusPrefix = status ? `[${status}] ` : "";

    if (status === 401) {
      return `${statusPrefix}Discord authentication failed${where}.\nCheck that DISCORD_BOT_TOKEN is set and the bot user has not been revoked.`;
    }
    if (status === 403) {
      return `${statusPrefix}Discord forbade the request${where}.\nThe bot likely lacks permissions in that channel/guild, or the required Gateway Intent (Guilds / GuildMessages / GuildMembers / MessageContent) is disabled.`;
    }
    if (status === 404) {
      return `${statusPrefix}Not found${where}.\nThe channel, message, user or guild id is wrong, the resource was deleted, or the bot isn't in that guild.`;
    }
    if (status === 429) {
      return `${statusPrefix}Discord rate limit exceeded${where}.\nSlow down and retry after the window resets.`;
    }

    const detail = e.rawError?.message;
    const base = detail ? `${error.message}: ${detail}` : error.message;
    return `${statusPrefix}Discord API error${where}: ${base}`;
  }
  return String(error);
}
