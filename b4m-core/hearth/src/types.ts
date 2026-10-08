/**
 * Core Hearth domain types.
 *
 * The substrate is an append-only event log; chat, quest boards, and the
 * Tavern map are projections of it. Every participant (human, agent, gateway,
 * device) is an actor. Persistent store implementations must stay in sync
 * with these shapes (see HearthStore in store.ts).
 */

export type ActorKind = 'human' | 'agent' | 'gateway' | 'device' | 'system';

export interface ActorReachability {
  /** Transport identifier, e.g. 'ws', 'telegram', 'slack', 'email', 'sms'. */
  transport: string;
  /** Transport-specific address (chat id, channel id, email address...). */
  address: string;
  /** Lower value = tried first when escalating to reach the actor. */
  priority: number;
}

export interface HearthActor {
  id: string;
  kind: ActorKind;
  displayName: string;
  /** Capability strings, e.g. 'cli.exec:<device>', 'gate.approve'. */
  capabilities: string[];
  reachability: ActorReachability[];
  /** Spawning actor for sub-agents; preserves audit lineage. */
  parentActorId?: string;
  createdAt: Date;
}

export type HearthEventKind =
  | 'message'
  | 'edit'
  | 'reaction'
  | 'artifact'
  | 'presence'
  | 'delegation'
  | 'quest.update'
  | 'gate.request'
  | 'gate.resolve'
  | 'system';

/** Human-renderable body. Always present so every surface can display it. */
export interface HearthHumanBody {
  text: string;
  /**
   * A renderer of 'md' must sanitize and disable raw HTML: the text is
   * actor-written, and gateways will feed it in from external networks.
   */
  format: 'md' | 'text';
}

/**
 * Optional typed payload for agents. `schema` names the payload contract
 * (e.g. 'hearth.gate.request@1') so consumers can validate before acting.
 */
export interface HearthMachineBody {
  schema: string;
  payload: unknown;
}

export interface HearthEventRefs {
  /** Root event of the thread this event belongs to. */
  threadRootId?: string;
  replyToId?: string;
  /** Binds a thread to a work object (e.g. a Tavern quest). */
  questId?: string;
  /**
   * Origin id on an external network (Slack ts, Telegram message id...).
   * Unique per channel; used by gateways for idempotent echo-dedupe.
   */
  externalId?: string;
}

/**
 * How the writer of an event authenticated. 'gateway' is derived from the
 * self-claimed actor kind, so it marks untrusted third-party input; it is a
 * trust downgrade, never a proof of gateway identity.
 */
export type HearthEventOrigin = 'session' | 'api-key' | 'gateway';

export interface HearthEvent {
  id: string;
  channelId: string;
  /** Monotonic per-channel sequence number; the replay cursor unit. */
  seq: number;
  actorId: string;
  kind: HearthEventKind;
  human: HearthHumanBody;
  machine?: HearthMachineBody;
  refs: HearthEventRefs;
  /**
   * Server-set by the writing route, never taken from a request body. Unset on
   * events written before provenance was recorded.
   */
  origin?: HearthEventOrigin;
  createdAt: Date;
}

/** Fields callers provide; id/seq/createdAt are assigned by the store. */
export type AppendEventInput = Omit<HearthEvent, 'id' | 'seq' | 'createdAt'>;

export interface HearthChannel {
  id: string;
  name: string;
  /** Set when the channel mirrors an external network via a gateway actor. */
  gatewayActorId?: string;
  createdAt: Date;
}

/** An actor's read position in a channel. seq 0 = nothing consumed yet. */
export interface HearthCursor {
  actorId: string;
  channelId: string;
  seq: number;
}
