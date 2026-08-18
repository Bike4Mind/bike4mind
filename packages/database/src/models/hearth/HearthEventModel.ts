import mongoose, { Schema, Model, model, Types } from 'mongoose';
import { hearthEventKindSchema, type HearthEventKind } from '@bike4mind/hearth';

/**
 * One event in the append-only Hearth log. Never updated, and deleted only by
 * the presence TTL below; chat, quest boards, and presence views are all
 * projections of this collection.
 * Must stay in sync with the domain shape in b4m-core/hearth/src/types.ts.
 */
export interface IHearthEventDoc {
  _id: Types.ObjectId;
  channelId: Types.ObjectId;
  /** Monotonic per-channel sequence number; the replay cursor unit. */
  seq: number;
  actorId: Types.ObjectId;
  kind: HearthEventKind;
  human: { text: string; format: 'md' | 'text' };
  machine?: { schema: string; payload: unknown };
  refs: {
    threadRootId?: string;
    replyToId?: string;
    questId?: string;
    externalId?: string;
  };
  createdAt: Date;
}

/**
 * How long a `presence` event lives before Mongo's TTL reaper removes it.
 *
 * 7 days matches the CodeAgentEvent precedent in this repo: longer than anyone
 * scrolls back, short enough to bound growth. Presence is the majority of real
 * traffic (several events per minute per live agent session, and it never
 * stops), so an unbounded presence history is the one part of this log that
 * grows without ever being read.
 *
 * DEPLOY NOTE: Mongo does not apply a changed expireAfterSeconds to an index
 * that already exists. After changing this value, run:
 *   db.runCommand({ collMod: 'hearthevents', index: { name: 'hearth_event_presence_ttl', expireAfterSeconds: <new> } })
 */
export const PRESENCE_EVENT_RETENTION_SECONDS = 7 * 24 * 60 * 60;

/** Narrowed against the boundary enum so renaming the kind breaks the build here. */
const PRESENCE_KIND = 'presence' satisfies HearthEventKind;

const HearthEventSchema = new Schema<IHearthEventDoc>(
  {
    channelId: { type: Schema.Types.ObjectId, required: true },
    seq: { type: Number, required: true },
    actorId: { type: Schema.Types.ObjectId, required: true },
    kind: {
      type: String,
      required: true,
      // Derived from the boundary schema so a new kind is a one-file change.
      enum: hearthEventKindSchema.options,
    },
    human: {
      type: new Schema(
        {
          text: { type: String, required: true },
          format: { type: String, required: true, enum: ['md', 'text'] },
        },
        { _id: false }
      ),
      required: true,
    },
    machine: {
      type: new Schema(
        {
          schema: { type: String, required: true },
          payload: { type: Schema.Types.Mixed },
        },
        { _id: false }
      ),
    },
    refs: {
      type: new Schema(
        {
          threadRootId: { type: String },
          replyToId: { type: String },
          questId: { type: String },
          externalId: { type: String },
        },
        { _id: false }
      ),
      default: {},
    },
  },
  // No updatedAt: the log is append-only.
  { timestamps: { createdAt: true, updatedAt: false } }
);

// The replay primitive: unique + ordered reads by (channel, seq).
HearthEventSchema.index({ channelId: 1, seq: 1 }, { unique: true, name: 'hearth_event_channel_seq' });
// Gateway echo-dedupe: an externalId may appear at most once per channel.
HearthEventSchema.index(
  { channelId: 1, 'refs.externalId': 1 },
  {
    unique: true,
    name: 'hearth_event_channel_external_id',
    partialFilterExpression: { 'refs.externalId': { $exists: true } },
  }
);
/**
 * Retention: `presence` events expire, and NOTHING else does. The partial
 * filter is the whole point - messages, gates, artifacts, and quest updates are
 * FACTS and stay permanent, while presence events are SNAPSHOTS of transient
 * state that are worthless once superseded.
 *
 * This only became safe with the presence roster (HearthPresenceModel): current
 * presence state now lives in that projection, so "who is here and are they
 * blocked on me" no longer has to be reconstructed by scanning presence
 * history. Before the roster landed, expiring these events would have destroyed
 * the only copy of that answer. The roster row is a separate collection and is
 * NOT touched by this TTL.
 *
 * Two consequences, both accepted:
 *  - hearth_catchup is no longer complete for presence beyond the window. That
 *    is the intended trade - stale presence is noise, and the roster holds the
 *    part that matters.
 *  - `seq` therefore develops gaps. This is already safe: eventsSince orders by
 *    seq and never assumes density (see the class comment on MongoHearthStore,
 *    which documents the same property for crashed-writer gaps). Do NOT "fix"
 *    the gaps by renumbering or backfilling - cursors are seq values, and
 *    rewriting them would rewind or skip every reader.
 */
HearthEventSchema.index(
  { createdAt: 1 },
  {
    name: 'hearth_event_presence_ttl',
    expireAfterSeconds: PRESENCE_EVENT_RETENTION_SECONDS,
    partialFilterExpression: { kind: PRESENCE_KIND },
  }
);

export interface IHearthEventModel extends Model<IHearthEventDoc> {}

export const HearthEventDoc: IHearthEventModel =
  mongoose.models.HearthEvent ?? model<IHearthEventDoc>('HearthEvent', HearthEventSchema);

export default HearthEventDoc;
