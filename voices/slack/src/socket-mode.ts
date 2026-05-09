import { SocketModeClient } from "@slack/socket-mode";

/**
 * Narrow shape of the inner Slack event payload our wrapper inspects.
 * Slack delivers a much wider object, but the inbox only cares about
 * the discriminator fields below — everything else lives in `raw` on
 * the resulting `InboxMessage`.
 */
export interface SlackEventLike {
  type: string;
  user?: string;
  bot_id?: string;
  channel?: string;
  text?: string;
  /** Set by Slack for non-default messages (edits, joins, channel_topic, …). Inbox ignores any subtype. */
  subtype?: string;
  ts: string;
  team?: string;
  thread_ts?: string;
}

/**
 * Narrow shape of the envelope that `SocketModeClient` hands to
 * `slack_event` listeners. The ack callback MUST be invoked within a
 * few seconds or Slack will retry the event.
 */
export interface SlackEventEnvelope {
  envelope_id: string;
  body: {
    type?: string;
    team_id?: string;
    event?: SlackEventLike;
    payload?: unknown;
  };
  ack: () => Promise<void>;
}

/** Narrow shape of `SocketModeClient` that the wrapper drives. */
export interface SocketModeClientLike {
  on(
    event: "slack_event",
    listener: (envelope: SlackEventEnvelope) => void | Promise<void>,
  ): void;
  start(): Promise<unknown>;
  disconnect(): Promise<unknown>;
}

/** Synchronous factory used by SlackClientWrapper; swappable in tests. */
export type SocketModeFactory = (appToken: string) => SocketModeClientLike;

/**
 * Default factory — instantiates the real `SocketModeClient` from
 * `@slack/socket-mode`. Cast through `unknown` once at this boundary
 * to avoid leaking the wider EventEmitter surface into the wrapper.
 */
export function defaultSocketModeFactory(appToken: string): SocketModeClientLike {
  return new SocketModeClient({ appToken }) as unknown as SocketModeClientLike;
}
