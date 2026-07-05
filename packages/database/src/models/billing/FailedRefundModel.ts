import mongoose, { Model, Schema, model } from 'mongoose';

const ModelName = 'FailedRefund';

export interface IFailedRefund {
  _id: string;
  qWorkRunId: string;
  kind: string;
  credits: number;
  reason: string;
  ownerId: string;
  ownerType: string;
  createdAt: Date;
}

interface IFailedRefundModel extends Model<IFailedRefund> {}

const FailedRefundSchema = new Schema<IFailedRefund>(
  {
    qWorkRunId: { type: String, required: true },
    kind: { type: String, required: true },
    credits: { type: Number, required: true },
    reason: { type: String, required: true },
    ownerId: { type: String, required: true },
    ownerType: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Unique compound index - prevents duplicate outbox entries per run+kind pair.
// No TTL: ops must manually reconcile failed refunds.
FailedRefundSchema.index({ qWorkRunId: 1, kind: 1 }, { unique: true });

export const FailedRefundModel: IFailedRefundModel =
  (mongoose.models[ModelName] as IFailedRefundModel) ||
  model<IFailedRefund, IFailedRefundModel>(ModelName, FailedRefundSchema);
