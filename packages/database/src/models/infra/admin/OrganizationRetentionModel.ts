import mongoose, { Schema } from 'mongoose';
import type { OrganizationRetentionPolicy } from '@bike4mind/common';

interface RetentionEstimate {
  token: string;
  organizationId: string;
  actorUserId: string;
  version: number;
  policy: OrganizationRetentionPolicy;
  counts: { chats: number; files: number; media: number };
  estimatedAt: Date;
  expiresAt: Date;
}

const estimateSchema = new Schema<RetentionEstimate>({
  token: { type: String, required: true, unique: true },
  organizationId: { type: String, required: true },
  actorUserId: { type: String, required: true },
  version: { type: Number, required: true },
  policy: { type: Schema.Types.Mixed, required: true },
  counts: { type: Schema.Types.Mixed, required: true },
  estimatedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
});
estimateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
estimateSchema.index({ actorUserId: 1 });

export const OrganizationRetentionEstimate =
  (mongoose.models.OrganizationRetentionEstimate as mongoose.Model<RetentionEstimate> | undefined) ??
  mongoose.model<RetentionEstimate>('OrganizationRetentionEstimate', estimateSchema);
