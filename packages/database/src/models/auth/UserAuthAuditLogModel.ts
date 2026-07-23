import mongoose, { Document, Model, model, Schema } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * Account-level authentication events worth a forensic trail. Login *failures*
 * are intentionally NOT included here - those flow to AuthFailLogModel and must
 * not be duplicated. Integration-level OAuth connect/disconnect lives in
 * IntegrationAuditLogModel; this collection captures identity-level events.
 *
 * `session_revoked` records an admin force-logout (revoke all of a user's sessions
 * via the tokenVersion kill switch); written by the admin revoke-sessions route.
 */
export type UserAuthAuditEvent =
  | 'login_success'
  | 'logout'
  | 'password_reset'
  | 'mfa_enrolled'
  | 'mfa_disabled'
  | 'oauth_link'
  | 'oauth_unlink'
  | 'session_revoked';

const USER_AUTH_AUDIT_EVENTS: UserAuthAuditEvent[] = [
  'login_success',
  'logout',
  'password_reset',
  'mfa_enrolled',
  'mfa_disabled',
  'oauth_link',
  'oauth_unlink',
  'session_revoked',
];

export interface IUserAuthAuditLogDocument extends Document {
  id: string;
  userId: string;
  event: UserAuthAuditEvent;
  /** Auth strategy involved, when relevant (e.g. oauth_link/oauth_unlink). */
  strategy?: string;
  actorIp: string;
  userAgent: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date; // Required by Document constraint; not auto-set (timestamps.updatedAt: false)
}

export interface CreateUserAuthAuditLogInput {
  userId: string;
  event: UserAuthAuditEvent;
  strategy?: string;
  actorIp: string;
  userAgent: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

const UserAuthAuditLogSchema = new Schema<IUserAuthAuditLogDocument>(
  {
    userId: { type: String, required: true },
    event: { type: String, required: true, enum: USER_AUTH_AUDIT_EVENTS },
    strategy: { type: String },
    actorIp: { type: String, required: true },
    userAgent: { type: String, required: true },
    requestId: { type: String },
    metadata: { type: Map, of: Schema.Types.Mixed, default: {} },
  },
  {
    toJSON: {
      virtuals: true,
      transform: function (_doc, ret) {
        if (ret.metadata instanceof Map) {
          ret.metadata = Object.fromEntries(ret.metadata);
        }
        return ret;
      },
    },
    toObject: {
      virtuals: true,
      transform: function (_doc, ret) {
        if (ret.metadata instanceof Map) {
          ret.metadata = Object.fromEntries(ret.metadata);
        }
        return ret;
      },
    },
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  }
);

// All performance indexes declared together for auditability (no inline index: true).
UserAuthAuditLogSchema.index({ userId: 1, createdAt: -1 });
UserAuthAuditLogSchema.index({ event: 1, createdAt: -1 });

// TTL index to auto-delete old audit logs after 90 days (consistent with IntegrationAuditLog).
UserAuthAuditLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 } // 90 days
);

export const UserAuthAuditLogModel: Model<IUserAuthAuditLogDocument> =
  (mongoose.models.UserAuthAuditLog as unknown as Model<IUserAuthAuditLogDocument>) ??
  model<IUserAuthAuditLogDocument>('UserAuthAuditLog', UserAuthAuditLogSchema);

class UserAuthAuditLogRepository extends BaseRepository<IUserAuthAuditLogDocument> {
  constructor() {
    super(UserAuthAuditLogModel);
  }

  async createLog(data: CreateUserAuthAuditLogInput): Promise<IUserAuthAuditLogDocument> {
    const result = await this.model.create(data);
    return result.toJSON() as unknown as IUserAuthAuditLogDocument;
  }

  async findByUser(userId: string, limit = 50): Promise<IUserAuthAuditLogDocument[]> {
    return this.model.find({ userId }).sort({ createdAt: -1 }).limit(limit);
  }
}

export const userAuthAuditLogRepository = new UserAuthAuditLogRepository();
