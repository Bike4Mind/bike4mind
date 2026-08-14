import { Types } from 'mongoose';
import type { AppendEventInput, HearthEvent, HearthStore, EventsSinceOptions } from '@bike4mind/hearth';
import { HearthChannel, type IHearthChannelDoc } from './HearthChannelModel.js';
import { HearthActor, type IHearthActorDoc } from './HearthActorModel.js';
import { HearthEventDoc, type IHearthEventDoc } from './HearthEventModel.js';
import { HearthCursor } from './HearthCursorModel.js';
import {
  HearthPresence,
  PRESENCE_STATE_RANK,
  presenceStateForReason,
  type IHearthPresenceDoc,
} from './HearthPresenceModel.js';

/** What a rendering surface needs to name and badge an actor. */
export interface HearthActorIdentity {
  displayName: string;
  kind: IHearthActorDoc['kind'];
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

function toDomainEvent(doc: IHearthEventDoc): HearthEvent {
  return {
    id: doc._id.toString(),
    channelId: doc.channelId.toString(),
    seq: doc.seq,
    actorId: doc.actorId.toString(),
    kind: doc.kind,
    human: { text: doc.human.text, format: doc.human.format },
    machine: doc.machine ? { schema: doc.machine.schema, payload: doc.machine.payload } : undefined,
    refs: {
      threadRootId: doc.refs?.threadRootId,
      replyToId: doc.refs?.replyToId,
      questId: doc.refs?.questId,
      externalId: doc.refs?.externalId,
    },
    createdAt: doc.createdAt,
  };
}

/**
 * MongoDB implementation of the HearthStore persistence contract
 * (b4m-core/hearth/src/store.ts).
 *
 * Seq allocation: an atomic $inc on the channel's nextSeq counter hands each
 * concurrent writer a distinct, strictly increasing seq, so the unique
 * (channelId, seq) index can never collide between two live writers. The one
 * departure from the in-memory store: if the process dies between the $inc
 * and the insert, that seq is burned and the channel has a numbering gap.
 * Readers are unaffected - eventsSince orders by seq and never assumes
 * density - so this is an accepted trade for lock-free concurrent appends.
 * The presence TTL in HearthEventModel is the other, routine source of gaps
 * and relies on this same density-independence.
 */
export class MongoHearthStore implements HearthStore {
  async appendEvent(input: AppendEventInput): Promise<HearthEvent> {
    const channelId = new Types.ObjectId(input.channelId);

    // Gateway echo-dedupe fast path: return the existing event for a known externalId.
    if (input.refs.externalId) {
      const existing = await HearthEventDoc.findOne({
        channelId,
        'refs.externalId': input.refs.externalId,
      });
      if (existing) return toDomainEvent(existing);
    }

    const channel = await HearthChannel.findOneAndUpdate({ _id: channelId }, { $inc: { nextSeq: 1 } }, { new: true });
    if (!channel) {
      throw new Error(`Hearth channel not found: ${input.channelId}`);
    }

    try {
      const doc = await HearthEventDoc.create({
        channelId,
        seq: channel.nextSeq,
        actorId: new Types.ObjectId(input.actorId),
        kind: input.kind,
        human: input.human,
        machine: input.machine,
        refs: input.refs,
      });
      return toDomainEvent(doc);
    } catch (err) {
      // Two gateways racing the same externalId: the partial unique index rejects
      // the loser; hand back the winner so the caller sees idempotent append.
      if (isDuplicateKeyError(err) && input.refs.externalId) {
        const winner = await HearthEventDoc.findOne({
          channelId,
          'refs.externalId': input.refs.externalId,
        });
        if (winner) return toDomainEvent(winner);
      }
      throw err;
    }
  }

  async eventsSince(channelId: string, sinceSeq: number, options: EventsSinceOptions = {}): Promise<HearthEvent[]> {
    const query = HearthEventDoc.find({
      channelId: new Types.ObjectId(channelId),
      seq: { $gt: sinceSeq },
    }).sort({ seq: 1 });

    if (options.limit !== undefined) {
      query.limit(options.limit);
    }

    const docs = await query;
    return docs.map(toDomainEvent);
  }

  async getCursor(actorId: string, channelId: string): Promise<number> {
    const cursor = await HearthCursor.findOne({
      actorId: new Types.ObjectId(actorId),
      channelId: new Types.ObjectId(channelId),
    });
    return cursor?.seq ?? 0;
  }

  async setCursor(actorId: string, channelId: string, seq: number): Promise<void> {
    // $max keeps a stale writer from rewinding a cursor another process advanced.
    await HearthCursor.findOneAndUpdate(
      { actorId: new Types.ObjectId(actorId), channelId: new Types.ObjectId(channelId) },
      { $max: { seq } },
      { upsert: true }
    );
  }
}

/**
 * Hard ceiling on rows returned for one channel's roster.
 *
 * Generous for the real case (a human with a handful of live sessions) while
 * keeping an aged account's accreted rows from turning every roster read into an
 * unbounded in-memory sort. Exported so the route can advertise the same bound.
 */
export const MAX_ROSTER_ROWS = 200;

/** Fields a presence event contributes to the roster row it projects onto. */
export interface UpsertPresenceInput {
  channelId: string;
  actorId: string;
  userId: string;
  /** Event time, NOT write time: the roster orders by when the actor was seen. */
  lastSeen: Date;
  /** Raw reason code from the event payload; mapped to a state by the model. */
  reason?: string;
  workspace?: string;
  tool?: string;
  permissionMode?: string;
  effort?: string;
  sessionId?: string;
  slug?: string;
  subagent?: string;
  backgroundTasks?: number;
}

/** Optional detail fields, split into the ones to write and the ones to clear. */
function splitPresenceDetail(input: UpsertPresenceInput) {
  const detail: Record<string, string | number | undefined> = {
    workspace: input.workspace,
    tool: input.tool,
    permissionMode: input.permissionMode,
    effort: input.effort,
    sessionId: input.sessionId,
    slug: input.slug,
    subagent: input.subagent,
    backgroundTasks: input.backgroundTasks,
  };
  const set: Record<string, string | number> = {};
  const unset: Record<string, ''> = {};
  for (const [field, value] of Object.entries(detail)) {
    // A newer event that omits a field means the field no longer applies (the
    // tool finished, the subagent exited). Clearing beats keeping stale detail:
    // the row is a snapshot, and a lingering tool name reads as current.
    if (value === undefined) unset[field] = '';
    else set[field] = value;
  }
  return { set, unset };
}

/**
 * User-scoped helpers used by the /api/hearth/* routes. Phase 3 scopes all
 * channel access to the owning user; org/multi-user channels come later.
 */
export const hearthRepository = {
  store: new MongoHearthStore(),

  async listChannelsForUser(userId: string): Promise<IHearthChannelDoc[]> {
    return HearthChannel.find({ userId: new Types.ObjectId(userId) }).sort({ createdAt: 1 });
  },

  /**
   * Existence check only. Separate from listChannelsForUser because the gear
   * unlock in /api/gears/status is polled often and needs one indexed lookup,
   * not every channel document hydrated to read .length.
   */
  async hasAnyChannelForUser(userId: string): Promise<boolean> {
    return (await HearthChannel.exists({ userId: new Types.ObjectId(userId) })) !== null;
  },

  async createChannel(userId: string, name: string): Promise<IHearthChannelDoc> {
    return HearthChannel.create({ userId: new Types.ObjectId(userId), name });
  },

  /**
   * Find-or-create a channel by (user, name). Atomic upsert against the unique
   * (userId, name) index, so two writers racing the very first write - a bridge
   * register and a Claude Code hook heartbeat arriving together - cannot end up
   * with two channels of the same name or a failed presence report.
   */
  async ensureChannelByName(userId: string, name: string): Promise<IHearthChannelDoc> {
    const filter = { userId: new Types.ObjectId(userId), name };
    try {
      return await HearthChannel.findOneAndUpdate(
        filter,
        { $setOnInsert: { nextSeq: 0 } },
        { upsert: true, new: true }
      );
    } catch (err) {
      // An upsert whose filter misses can still lose the insert race and take
      // E11000 from the unique index. The row exists by then, so re-reading it
      // is the correct answer rather than propagating the collision.
      if (isDuplicateKeyError(err)) {
        const winner = await HearthChannel.findOne(filter);
        if (winner) return winner;
      }
      throw err;
    }
  },

  /** Returns the channel only if it belongs to the user; null otherwise. */
  async getOwnedChannel(userId: string, channelId: string): Promise<IHearthChannelDoc | null> {
    if (!Types.ObjectId.isValid(channelId)) return null;
    return HearthChannel.findOne({
      _id: new Types.ObjectId(channelId),
      userId: new Types.ObjectId(userId),
    });
  },

  /**
   * Find-or-create an actor by (user, kind, displayName). Atomic upsert so
   * concurrent first-posts from the same actor identity cannot double-create.
   *
   * `displayLabel` is refreshed on every call rather than set on insert: it is
   * the renameable friendly name, so the point is that it tracks the current
   * value without disturbing the identity the cursor hangs off. Passing it as
   * undefined leaves whatever is stored alone, so a caller that has no label
   * cannot blank one another caller set.
   */
  async ensureActor(
    userId: string,
    kind: IHearthActorDoc['kind'],
    displayName: string,
    options: { displayLabel?: string } = {}
  ): Promise<IHearthActorDoc> {
    return HearthActor.findOneAndUpdate(
      { userId: new Types.ObjectId(userId), kind, displayName },
      {
        $setOnInsert: { capabilities: [], reachability: [] },
        ...(options.displayLabel ? { $set: { displayLabel: options.displayLabel } } : {}),
      },
      { upsert: true, new: true }
    );
  },

  /**
   * Last N events of a channel by event count (not seq arithmetic, which
   * can undercount when burned seqs cluster near the end). For rendering
   * surfaces; never touches cursors.
   */
  async tailEvents(channelId: string, n: number): Promise<HearthEvent[]> {
    const docs = await HearthEventDoc.find({ channelId: new Types.ObjectId(channelId) })
      .sort({ seq: -1 })
      .limit(n);
    return docs.reverse().map(toDomainEvent);
  },

  /**
   * Resolve actor identities for a batch of events (for rendering surfaces).
   * The name prefers the renameable friendly label and falls back to the
   * identity name. `kind` travels with it because surfaces badge the kind, so a
   * self-chosen displayName cannot pass for a session-derived human actor.
   */
  async actorIdentitiesById(actorIds: string[]): Promise<Map<string, HearthActorIdentity>> {
    const unique = [...new Set(actorIds)].map(id => new Types.ObjectId(id));
    const actors = await HearthActor.find({ _id: { $in: unique } }, { displayName: 1, displayLabel: 1, kind: 1 });
    return new Map(
      actors.map(a => [a._id.toString(), { displayName: a.displayLabel ?? a.displayName, kind: a.kind }])
    );
  },

  /**
   * Project a presence event onto its (channel, actor) roster row.
   *
   * The `lastSeen: { $lt }` guard is the same reasoning as the $max in
   * setCursor, applied to a whole document: a late or replayed event must not
   * drag the row back to an older state. Because the guard is part of the
   * filter, a stale event stops matching the existing row, the upsert then
   * attempts an insert, and the unique (channelId, actorId) index rejects it -
   * so "no-op" arrives as a duplicate-key error rather than a lost update.
   * Ties on the exact same millisecond resolve in favor of the first writer.
   *
   * Returns the new row, or null when the event was too old to apply.
   */
  async upsertPresence(input: UpsertPresenceInput): Promise<IHearthPresenceDoc | null> {
    const { set, unset } = splitPresenceDetail(input);
    if (input.reason) set.reason = input.reason;
    else unset.reason = '';

    const update = {
      $set: {
        userId: new Types.ObjectId(input.userId),
        state: presenceStateForReason(input.reason),
        lastSeen: input.lastSeen,
        ...set,
      },
      // Mongo rejects an empty $unset, so only include it when something clears.
      ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
    };

    const filter = {
      channelId: new Types.ObjectId(input.channelId),
      actorId: new Types.ObjectId(input.actorId),
      lastSeen: { $lt: input.lastSeen },
    };

    try {
      return await HearthPresence.findOneAndUpdate(filter, update, { upsert: true, new: true });
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      // With no row yet, two in-flight events both miss the $lt filter and both
      // try to insert; the loser takes E11000. Reading that as "too old" dropped
      // a NEWER event whenever it lost the race, leaving the row on the older
      // state. The row exists by now, so a retry lets the $lt guard make the real
      // decision instead of the race deciding for it. Same treatment
      // ensureChannelByName already gets a few methods up.
      try {
        return await HearthPresence.findOneAndUpdate(filter, update, { upsert: true, new: true });
      } catch (retryErr) {
        // A second E11000 is the meaningful one: the row now exists AND its
        // lastSeen is at or past this event's, so the filter legitimately misses
        // and this event really is stale.
        if (isDuplicateKeyError(retryErr)) return null;
        throw retryErr;
      }
    }
  },

  /**
   * The roster for a channel, already ordered needs-you-first. Ordering is done
   * here rather than in the client because the roster is an inbox, not a feed:
   * every consumer wants the same "who is blocked on me" answer at the top, and
   * duplicating the ranking per surface is how two clients drift apart.
   *
   * Bounded by MAX_ROSTER_ROWS. The read was unbounded in every dimension, which
   * is a growth problem rather than a hypothetical: actors are minted one per
   * session BY DESIGN, nothing deletes a presence row (the retention TTL covers
   * events, not this projection), and every session on every machine accretes a
   * row in the one shared default channel. The $sort is on an $addFields key no
   * index can serve, so it is always an in-memory sort - which a $limit turns
   * from "proportional to a user's lifetime session count" into a bounded top-k.
   * Truncation drops the LEAST urgent, least recent rows, because the ranking
   * runs before the limit.
   */
  async presenceForChannel(
    userId: string,
    channelId: string,
    options: { limit?: number } = {}
  ): Promise<IHearthPresenceDoc[]> {
    const branches = Object.entries(PRESENCE_STATE_RANK).map(([state, rank]) => ({
      case: { $eq: ['$state', state] },
      then: rank,
    }));

    return HearthPresence.aggregate<IHearthPresenceDoc>([
      { $match: { userId: new Types.ObjectId(userId), channelId: new Types.ObjectId(channelId) } },
      // An unrecognized state sorts last rather than first, so a future writer
      // cannot accidentally promote rows to the top of someone's inbox.
      { $addFields: { stateRank: { $switch: { branches, default: branches.length } } } },
      { $sort: { stateRank: 1, lastSeen: -1 } },
      // Clamped into [1, MAX_ROSTER_ROWS]: Mongo rejects a non-positive $limit
      // outright, so a caller passing 0 (or a negative) would take down the whole
      // roster read rather than merely asking for something meaningless.
      { $limit: Math.max(1, Math.min(options.limit ?? MAX_ROSTER_ROWS, MAX_ROSTER_ROWS)) },
      { $project: { stateRank: 0 } },
    ]);
  },
};
