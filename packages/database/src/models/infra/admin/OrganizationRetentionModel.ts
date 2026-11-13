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

interface RetainedGeneratedObject {
  key: string;
  organizationId: string;
  userId: string;
  sessionId: string;
  createdAt: Date;
  deletedAt?: Date;
  lastCheckedAt?: Date;
}

const objectSchema = new Schema<RetainedGeneratedObject>({
  key: { type: String, required: true, unique: true, immutable: true },
  organizationId: { type: String, required: true, immutable: true },
  userId: { type: String, required: true, immutable: true },
  sessionId: { type: String, required: true, immutable: true },
  createdAt: { type: Date, required: true, immutable: true },
  deletedAt: { type: Date },
  lastCheckedAt: { type: Date },
});
objectSchema.index({ organizationId: 1, deletedAt: 1, createdAt: 1, _id: 1 });
objectSchema.index({ organizationId: 1, deletedAt: 1, lastCheckedAt: 1, _id: 1 });

export const OrganizationRetentionEstimate =
  (mongoose.models.OrganizationRetentionEstimate as mongoose.Model<RetentionEstimate> | undefined) ??
  mongoose.model<RetentionEstimate>('OrganizationRetentionEstimate', estimateSchema);
export const OrganizationGeneratedObject =
  (mongoose.models.OrganizationGeneratedObject as mongoose.Model<RetainedGeneratedObject> | undefined) ??
  mongoose.model<RetainedGeneratedObject>('OrganizationGeneratedObject', objectSchema);
