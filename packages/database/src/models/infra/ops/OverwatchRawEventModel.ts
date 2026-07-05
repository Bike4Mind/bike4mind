import mongoose, { Model, Schema, model } from 'mongoose';

const ModelName = 'OverwatchRawEvent';

export interface IOverwatchRawEventDoc {
  _id: string;
  eventId: string;
  schemaVersion: number;
  productId: string;
  userId: string;
  sessionId: string;
  event: string;
  timestamp: string;
  referrer?: string;
  utm?: {
    source?: string;
    medium?: string;
    campaign?: string;
    content?: string;
  };
  metadata?: Record<string, string | number | boolean>;
  createdAt: Date;
}

interface IOverwatchRawEventModel extends Model<IOverwatchRawEventDoc> {}

const OverwatchRawEventSchema = new Schema<IOverwatchRawEventDoc>(
  {
    eventId: { type: String, required: true, unique: true },
    schemaVersion: { type: Number, required: true },
    productId: { type: String, required: true },
    userId: { type: String, required: true },
    sessionId: { type: String, required: true },
    event: { type: String, required: true },
    timestamp: { type: String, required: true },
    referrer: { type: String },
    utm: {
      type: new Schema(
        {
          source: { type: String },
          medium: { type: String },
          campaign: { type: String },
          content: { type: String },
        },
        { _id: false }
      ),
    },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

// Performance indexes
OverwatchRawEventSchema.index({ productId: 1, timestamp: -1 });
// TTL: auto-delete raw events after 90 days
OverwatchRawEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });

export const OverwatchRawEvent: IOverwatchRawEventModel =
  (mongoose.models[ModelName] as IOverwatchRawEventModel) ||
  model<IOverwatchRawEventDoc, IOverwatchRawEventModel>(ModelName, OverwatchRawEventSchema);
