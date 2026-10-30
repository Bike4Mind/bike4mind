import mongoose, { model, Schema, type Model } from 'mongoose';

type BusinessMetricStateRecord = {
  _id: string;
  subscribers?: number;
  sampledAt?: Date;
  deliveredAt?: Date;
  leaseUntil?: Date;
  leaseToken?: string;
  expiresAt: Date;
};

const schema = new Schema<BusinessMetricStateRecord>(
  {
    _id: { type: String, required: true },
    subscribers: Number,
    sampledAt: Date,
    deliveredAt: Date,
    leaseUntil: Date,
    leaseToken: String,
    expiresAt: { type: Date, required: true },
  },
  { collection: 'businessmetricstate' }
);
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const BusinessMetricState: Model<BusinessMetricStateRecord> =
  (mongoose.models.BusinessMetricState as Model<BusinessMetricStateRecord> | undefined) ??
  model<BusinessMetricStateRecord>('BusinessMetricState', schema);
