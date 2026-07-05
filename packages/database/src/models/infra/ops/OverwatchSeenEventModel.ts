import mongoose, { Model, Schema, model } from 'mongoose';

const ModelName = 'OverwatchSeenEvent';

export interface IOverwatchSeenEventDoc {
  _id: string;
  eventId: string;
  createdAt: Date;
}

interface IOverwatchSeenEventModel extends Model<IOverwatchSeenEventDoc> {}

const OverwatchSeenEventSchema = new Schema<IOverwatchSeenEventDoc>(
  {
    eventId: { type: String, required: true, unique: true },
  },
  { timestamps: true }
);

// TTL: auto-delete dedup records after 7 days
OverwatchSeenEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 });

export const OverwatchSeenEvent: IOverwatchSeenEventModel =
  (mongoose.models[ModelName] as IOverwatchSeenEventModel) ||
  model<IOverwatchSeenEventDoc, IOverwatchSeenEventModel>(ModelName, OverwatchSeenEventSchema);
