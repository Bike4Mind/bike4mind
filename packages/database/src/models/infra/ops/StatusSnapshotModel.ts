import mongoose, { Model, Schema, model } from 'mongoose';

const ModelName = 'StatusSnapshot';

export interface IStatusSnapshotDoc {
  kind: string;
  /** File name. One document per key: the latest snapshot only. */
  key: string;
  body: string;
  etag: string;
  seq: number;
  generatedAt: Date;
  probesAsOf: Date;
  publishedAt?: Date;
  publishError?: string;
}

interface IStatusSnapshotModel extends Model<IStatusSnapshotDoc> {}

const StatusSnapshotSchema = new Schema<IStatusSnapshotDoc>(
  {
    kind: { type: String, required: true },
    key: { type: String, required: true },
    body: { type: String, required: true },
    etag: { type: String, required: true },
    seq: { type: Number, required: true },
    generatedAt: { type: Date, required: true },
    probesAsOf: { type: Date, required: true },
    publishedAt: { type: Date },
    publishError: { type: String },
  },
  { collection: 'statusSnapshots' }
);

// The unique index is built by the status-page-indexes migration.
StatusSnapshotSchema.index({ key: 1 }, { unique: true });

export const StatusSnapshot: IStatusSnapshotModel =
  (mongoose.models[ModelName] as IStatusSnapshotModel) ||
  model<IStatusSnapshotDoc, IStatusSnapshotModel>(ModelName, StatusSnapshotSchema);
