import mongoose, { Model, Schema, model } from 'mongoose';

const ModelName = 'StatusHistoryCorrection';

export const STATUS_HISTORY_TREAT_AS = ['unknown'] as const;
export type StatusHistoryTreatAs = (typeof STATUS_HISTORY_TREAT_AS)[number];

export interface IStatusHistoryCorrectionDoc {
  componentKey: string;
  from: Date;
  to: Date;
  treatAs: StatusHistoryTreatAs;
  reason: string;
  actorId: string;
}

interface IStatusHistoryCorrectionModel extends Model<IStatusHistoryCorrectionDoc> {}

const StatusHistoryCorrectionSchema = new Schema<IStatusHistoryCorrectionDoc>(
  {
    componentKey: { type: String, required: true },
    from: { type: Date, required: true },
    to: { type: Date, required: true },
    treatAs: { type: String, enum: STATUS_HISTORY_TREAT_AS, required: true },
    reason: { type: String, required: true },
    actorId: { type: String, required: true },
  },
  { collection: 'statusHistoryCorrections' }
);

StatusHistoryCorrectionSchema.index({ componentKey: 1, from: -1 });

export const StatusHistoryCorrection: IStatusHistoryCorrectionModel =
  (mongoose.models[ModelName] as IStatusHistoryCorrectionModel) ||
  model<IStatusHistoryCorrectionDoc, IStatusHistoryCorrectionModel>(ModelName, StatusHistoryCorrectionSchema);
