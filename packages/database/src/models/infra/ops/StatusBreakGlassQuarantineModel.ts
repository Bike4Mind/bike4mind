import mongoose, { Model, Schema, model } from 'mongoose';

const ModelName = 'StatusBreakGlassQuarantine';

export const STATUS_QUARANTINE_REASONS = [
  'no_journal',
  'hash_mismatch',
  'text_policy',
  'protected_target',
  'schema',
] as const;
export type StatusQuarantineReason = (typeof STATUS_QUARANTINE_REASONS)[number];

export interface IStatusBreakGlassQuarantineDoc {
  entryHash: string;
  journalKey?: string;
  actorId?: string;
  writtenSeq: number;
  reason: StatusQuarantineReason;
  entry: unknown;
  resolvedBy?: string;
  resolution?: string;
}

interface IStatusBreakGlassQuarantineModel extends Model<IStatusBreakGlassQuarantineDoc> {}

const StatusBreakGlassQuarantineSchema = new Schema<IStatusBreakGlassQuarantineDoc>(
  {
    entryHash: { type: String, required: true },
    journalKey: { type: String },
    actorId: { type: String },
    writtenSeq: { type: Number, required: true },
    reason: { type: String, enum: STATUS_QUARANTINE_REASONS, required: true },
    entry: { type: Schema.Types.Mixed, required: true },
    resolvedBy: { type: String },
    resolution: { type: String },
  },
  { collection: 'statusBreakGlassQuarantine' }
);

StatusBreakGlassQuarantineSchema.index({ writtenSeq: -1 });

export const StatusBreakGlassQuarantine: IStatusBreakGlassQuarantineModel =
  (mongoose.models[ModelName] as IStatusBreakGlassQuarantineModel) ||
  model<IStatusBreakGlassQuarantineDoc, IStatusBreakGlassQuarantineModel>(ModelName, StatusBreakGlassQuarantineSchema);
