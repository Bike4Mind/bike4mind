import mongoose, { Schema, Model, model, Types } from 'mongoose';
import { hearthEventKindSchema, type HearthEventKind } from '@bike4mind/hearth';

/**
 * One event in the append-only Hearth log. Never updated or deleted; chat,
 * quest boards, and presence views are all projections of this collection.
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

export interface IHearthEventModel extends Model<IHearthEventDoc> {}

export const HearthEventDoc: IHearthEventModel =
  mongoose.models.HearthEvent ?? model<IHearthEventDoc>('HearthEvent', HearthEventSchema);

export default HearthEventDoc;
