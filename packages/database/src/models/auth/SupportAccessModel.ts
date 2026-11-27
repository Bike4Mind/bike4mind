import mongoose, { Schema, model, type Model } from 'mongoose';

export interface SupportAccessRecord {
  sid: string;
  userId: string;
  adminId: string;
  reason: string;
  startedAt: Date;
  expiresAt: Date;
  endedAt?: Date | null;
  escalatedAt?: Date | null;
  escalationReason?: string;
}

const schema = new Schema<SupportAccessRecord>({
  sid: { type: String, required: true, unique: true },
  userId: { type: String, required: true },
  adminId: { type: String, required: true },
  reason: { type: String, required: true, select: false },
  startedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  endedAt: { type: Date, default: null },
  escalatedAt: { type: Date, default: null },
  escalationReason: { type: String, select: false },
});
schema.index({ userId: 1, startedAt: -1 });
schema.index({ endedAt: 1, expiresAt: 1 });

export const SupportAccess: Model<SupportAccessRecord> =
  (mongoose.models.SupportAccess as Model<SupportAccessRecord> | undefined) ??
  model<SupportAccessRecord>('SupportAccess', schema);
