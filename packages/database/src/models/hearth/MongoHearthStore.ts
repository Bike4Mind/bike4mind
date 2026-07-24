import { Types } from 'mongoose';
import type { AppendEventInput, HearthEvent, HearthStore, EventsSinceOptions } from '@bike4mind/hearth';
import { HearthChannel, type IHearthChannelDoc } from './HearthChannelModel.js';
import { HearthActor, type IHearthActorDoc } from './HearthActorModel.js';
import { HearthEventDoc, type IHearthEventDoc } from './HearthEventModel.js';
import { HearthCursor } from './HearthCursorModel.js';

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
 * User-scoped helpers used by the /api/hearth/* routes. Phase 3 scopes all
 * channel access to the owning user; org/multi-user channels come later.
 */
export const hearthRepository = {
  store: new MongoHearthStore(),

  async listChannelsForUser(userId: string): Promise<IHearthChannelDoc[]> {
    return HearthChannel.find({ userId: new Types.ObjectId(userId) }).sort({ createdAt: 1 });
  },

  async createChannel(userId: string, name: string): Promise<IHearthChannelDoc> {
    return HearthChannel.create({ userId: new Types.ObjectId(userId), name });
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
   */
  async ensureActor(userId: string, kind: IHearthActorDoc['kind'], displayName: string): Promise<IHearthActorDoc> {
    return HearthActor.findOneAndUpdate(
      { userId: new Types.ObjectId(userId), kind, displayName },
      { $setOnInsert: { capabilities: [], reachability: [] } },
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

  /** Resolve actor display names for a batch of events (for rendering surfaces). */
  async actorNamesById(actorIds: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(actorIds)].map(id => new Types.ObjectId(id));
    const actors = await HearthActor.find({ _id: { $in: unique } }, { displayName: 1 });
    return new Map(actors.map(a => [a._id.toString(), a.displayName]));
  },
};
