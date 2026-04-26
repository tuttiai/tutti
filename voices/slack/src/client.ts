import { WebClient } from "@slack/web-api";
import { SecretsManager } from "@tuttiai/core";

/** Narrow shape of a Slack message returned by conversations.history. */
export interface SlackMessageLike {
  type?: string;
  ts: string;
  thread_ts?: string;
  channel?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  edited?: { ts: string; user?: string };
  permalink?: string;
}

/** Narrow shape of a channel returned by conversations.list / .info. */
export interface SlackConversationLike {
  id: string;
  name?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  num_members?: number;
  topic?: { value?: string };
  purpose?: { value?: string };
  created?: number;
}

/** Narrow shape of a user returned by users.list / .info. */
export interface SlackUserLike {
  id: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  deleted?: boolean;
  updated?: number;
  profile?: {
    real_name?: string;
    display_name?: string;
    email?: string;
    title?: string;
  };
}

/** Narrow shape of team.info. */
export interface SlackTeamLike {
  id: string;
  name: string;
  domain?: string;
  email_domain?: string;
  icon?: { image_132?: string; image_88?: string; image_44?: string };
}

/**
 * Minimal shape of the @slack/web-api WebClient surface that our tools
 * touch. Declared explicitly so tools can accept mocks in tests without
 * casting through the full WebClient class.
 */
export interface SlackClientLike {
  chat: {
    postMessage(args: {
      channel: string;
      text: string;
      thread_ts?: string;
    }): Promise<{ ok: boolean; ts?: string; channel?: string; message?: SlackMessageLike }>;
    update(args: {
      channel: string;
      ts: string;
      text: string;
    }): Promise<{ ok: boolean; ts?: string; channel?: string }>;
    delete(args: {
      channel: string;
      ts: string;
    }): Promise<{ ok: boolean; ts?: string; channel?: string }>;
    getPermalink(args: {
      channel: string;
      message_ts: string;
    }): Promise<{ ok: boolean; permalink?: string }>;
  };
  reactions: {
    add(args: {
      channel: string;
      timestamp: string;
      name: string;
    }): Promise<{ ok: boolean }>;
  };
  conversations: {
    history(args: {
      channel: string;
      limit?: number;
      latest?: string;
      oldest?: string;
      inclusive?: boolean;
    }): Promise<{ ok: boolean; messages?: SlackMessageLike[]; has_more?: boolean }>;
    list(args?: {
      types?: string;
      limit?: number;
      exclude_archived?: boolean;
      cursor?: string;
    }): Promise<{
      ok: boolean;
      channels?: SlackConversationLike[];
      response_metadata?: { next_cursor?: string };
    }>;
    info(args: {
      channel: string;
    }): Promise<{ ok: boolean; channel?: SlackConversationLike }>;
    open(args: {
      users: string;
    }): Promise<{ ok: boolean; channel?: { id: string } }>;
  };
  users: {
    list(args?: {
      limit?: number;
      cursor?: string;
    }): Promise<{
      ok: boolean;
      members?: SlackUserLike[];
      response_metadata?: { next_cursor?: string };
    }>;
    info(args: {
      user: string;
    }): Promise<{ ok: boolean; user?: SlackUserLike }>;
  };
  team: {
    info(args?: { team?: string }): Promise<{ ok: boolean; team?: SlackTeamLike }>;
  };
}

/** Synchronous factory used by SlackClientWrapper; swappable in tests. */
export type ClientFactory = (token: string) => SlackClientLike;

function defaultFactory(token: string): SlackClientLike {
  // The real @slack/web-api WebClient is structurally compatible with the
  // narrow methods we declare in SlackClientLike — chat / conversations /
  // reactions / users / team are all present on the instance with the
  // matching signatures. We cast through `unknown` once at this boundary
  // to avoid leaking the wider WebClient surface into every tool.
  return new WebClient(token) as unknown as SlackClientLike;
}

/**
 * Singleton wrapper around a Slack {@link WebClient}. The client is
 * created lazily on the first tool call; subsequent calls share the
 * same instance. Safe to call {@link getClient} concurrently — concurrent
 * calls await the same in-flight construction promise.
 *
 * Slack's WebClient is stateless HTTP under the hood, so there is no
 * gateway connection to keep alive — but we still memoise so we don't
 * repeatedly allocate axios agents and retry queues.
 */
export class SlackClientWrapper {
  private client?: SlackClientLike;
  private initPromise?: Promise<SlackClientLike>;

  constructor(
    private readonly token: string,
    private readonly factory: ClientFactory = defaultFactory,
  ) {}

  async getClient(): Promise<SlackClientLike> {
    if (this.client) return this.client;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const c = this.factory(this.token);
      this.client = c;
      return c;
    })();

    try {
      return await this.initPromise;
    } catch (err) {
      // Reset so the next call can retry from a clean state.
      this.initPromise = undefined;
      throw err;
    }
  }

  async destroy(): Promise<void> {
    // The Slack WebClient holds no long-lived sockets, so destroy is just
    // a cache clear. Kept for symmetry with the discord voice + the Voice
    // teardown contract.
    this.client = undefined;
    this.initPromise = undefined;
  }
}

/** Config for creating a SlackClient. Token falls back to env. */
export interface SlackClientOptions {
  /** Bot token (xoxb-...). Defaults to SLACK_BOT_TOKEN env var. */
  token?: string;
  /** Custom WebClient factory — primarily for tests. */
  clientFactory?: ClientFactory;
}

/**
 * Resolved client state — either usable or an explanatory "missing"
 * placeholder. Tools never throw on missing auth; they hand the message
 * back as a ToolResult via `guardClient`.
 */
export type SlackClient =
  | { kind: "ready"; wrapper: SlackClientWrapper }
  | { kind: "missing"; message: string };

/**
 * Resolve bot credentials from options then env. Never throws — returns
 * `kind: "missing"` when SLACK_BOT_TOKEN is unset so individual tool
 * calls can surface the same helpful message without crashing the voice
 * at construction time.
 */
export function createSlackClient(options: SlackClientOptions = {}): SlackClient {
  const token = options.token ?? SecretsManager.optional("SLACK_BOT_TOKEN");
  if (!token) {
    return {
      kind: "missing",
      message:
        "Slack voice is not configured. Set SLACK_BOT_TOKEN to a bot user token (xoxb-...) from https://api.slack.com/apps. The app must be installed to the target workspace with at least these scopes: channels:read, channels:history, chat:write, reactions:write, users:read, team:read; add groups:read + groups:history for private channels and im:write for DMs.",
    };
  }

  return {
    kind: "ready",
    wrapper: new SlackClientWrapper(token, options.clientFactory),
  };
}
