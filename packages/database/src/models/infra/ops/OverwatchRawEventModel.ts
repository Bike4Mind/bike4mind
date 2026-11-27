import mongoose, { Model, Schema, model } from 'mongoose';

const ModelName = 'OverwatchRawEvent';

/** Name of the partial `{ productId, timestamp }` index over credited (`metadata.attribution: 'self-reported'`) events. */
export const OVERWATCH_RAW_EVENT_CREDITED_INDEX = 'productId_1_timestamp_-1_attribution_self_reported';

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
// One named event (or an `$in` of a few) over a range: the Overwatch explorer, funnel signups,
// attribution, roads and the event trend. On `{productId, timestamp}` alone each of those reads every
// event the product sent in the window to keep the few named ones. Not a replacement for it: the
// event catalog, session counts, next steps and the newest-event seek name no event.
// Pre-built by 20260921235977_ensure-overwatch-raw-event-explorer-index rather than left to autoIndex.
OverwatchRawEventSchema.index({ productId: 1, event: 1, timestamp: -1 });
// Seeking and counting credited events without walking every event the product sent. Holds only
// credits, so a read must carry the `metadata.attribution: 'self-reported'` equality to use it (a `$ne`
// cannot). Named so it does not clash with the unfiltered `productId_1_timestamp_-1` of the same key.
OverwatchRawEventSchema.index(
  { productId: 1, timestamp: -1 },
  { name: OVERWATCH_RAW_EVENT_CREDITED_INDEX, partialFilterExpression: { 'metadata.attribution': 'self-reported' } }
);
// TTL: auto-delete raw events after 90 days
OverwatchRawEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });

export const OverwatchRawEvent: IOverwatchRawEventModel =
  (mongoose.models[ModelName] as IOverwatchRawEventModel) ||
  model<IOverwatchRawEventDoc, IOverwatchRawEventModel>(ModelName, OverwatchRawEventSchema);
