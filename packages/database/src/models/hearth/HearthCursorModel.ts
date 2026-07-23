import mongoose, { Schema, Model, model, Types } from 'mongoose';

/**
 * An actor's read position in a channel. seq 0 = nothing consumed yet.
 * Cursors-not-read-receipts is the core replay primitive: an agent waking
 * from a heartbeat asks "everything since my cursor" and gets ordered,
 * gap-free catch-up in one call.
 */
export interface IHearthCursorDoc {
  _id: Types.ObjectId;
  actorId: Types.ObjectId;
  channelId: Types.ObjectId;
  seq: number;
  updatedAt: Date;
}

const HearthCursorSchema = new Schema<IHearthCursorDoc>(
  {
    actorId: { type: Schema.Types.ObjectId, required: true },
    channelId: { type: Schema.Types.ObjectId, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { timestamps: { createdAt: false, updatedAt: true } }
);

HearthCursorSchema.index({ actorId: 1, channelId: 1 }, { unique: true, name: 'hearth_cursor_actor_channel' });

export interface IHearthCursorModel extends Model<IHearthCursorDoc> {}

export const HearthCursor: IHearthCursorModel =
  mongoose.models.HearthCursor ?? model<IHearthCursorDoc>('HearthCursor', HearthCursorSchema);

export default HearthCursor;
