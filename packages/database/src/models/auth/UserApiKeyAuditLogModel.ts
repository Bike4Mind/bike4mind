import mongoose, { Document, Schema } from 'mongoose';

export type UserApiKeyAuditAction = 'mint' | 'rotate' | 'revoke';

export interface IUserApiKeyAuditLogDocument extends Document {
  id: string;
  action: UserApiKeyAuditAction;
  keyId: string;
  productId?: string;
  actorUserId: string;
  actorIp?: string;
  actorUserAgent?: string;
  details?: Record<string, unknown>;
  createdAt: Date;
  expiresAt: Date;
}

const UserApiKeyAuditLogSchema = new Schema<IUserApiKeyAuditLogDocument>(
  {
    action: { type: String, enum: ['mint', 'rotate', 'revoke'], required: true },
    keyId: { type: String, required: true },
    productId: { type: String },
    actorUserId: { type: String, required: true },
    actorIp: { type: String },
    actorUserAgent: { type: String },
    details: { type: Schema.Types.Mixed },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

UserApiKeyAuditLogSchema.index({ productId: 1, createdAt: -1 });
UserApiKeyAuditLogSchema.index({ keyId: 1, createdAt: -1 });
UserApiKeyAuditLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const UserApiKeyAuditLog =
  (mongoose.models.UserApiKeyAuditLog as mongoose.Model<IUserApiKeyAuditLogDocument>) ??
  mongoose.model<IUserApiKeyAuditLogDocument>('UserApiKeyAuditLog', UserApiKeyAuditLogSchema);
