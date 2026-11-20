import mongoose, { Schema } from 'mongoose';

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
objectSchema.index({ userId: 1 });
objectSchema.index({ organizationId: 1, deletedAt: 1, createdAt: 1, _id: 1 });
objectSchema.index({ organizationId: 1, deletedAt: 1, lastCheckedAt: 1, _id: 1 });

export const OrganizationGeneratedObject =
  (mongoose.models.OrganizationGeneratedObject as mongoose.Model<RetainedGeneratedObject> | undefined) ??
  mongoose.model<RetainedGeneratedObject>('OrganizationGeneratedObject', objectSchema);
