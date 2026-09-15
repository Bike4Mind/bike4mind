import mongoose, { Model, model, Schema } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import {
  AdminSupportAccessAction,
  IAdminSupportAccessAuditLog,
  IAdminSupportAccessAuditLogDocument,
  IAdminSupportAccessAuditLogRepository,
} from '@bike4mind/common';

/** Support reads touch customer content, so the trail outlives the 90-day operational logs. */
const RETENTION_DAYS = 730;

interface IAdminSupportAccessAuditLogModel extends Model<IAdminSupportAccessAuditLogDocument> {}

const AdminSupportAccessAuditLogSchema = new Schema<IAdminSupportAccessAuditLogDocument>(
  {
    action: { type: String, enum: Object.values(AdminSupportAccessAction), required: true },
    actorUserId: { type: String, required: true },
    targetUserId: { type: String, required: true },
    sessionId: { type: String, required: true },
    supportCase: { type: String, required: true },
    actorIp: { type: String },
    actorUserAgent: { type: String },
    actorApiKeyId: { type: String },
    details: { type: Schema.Types.Mixed },
    expiresAt: { type: Date, required: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// "Who looked at this notebook?" - the question asked when a customer disputes a read.
AdminSupportAccessAuditLogSchema.index({ sessionId: 1, createdAt: -1 });
// "What did this admin read?" and "what was read about this user?"
AdminSupportAccessAuditLogSchema.index({ actorUserId: 1, createdAt: -1 });
AdminSupportAccessAuditLogSchema.index({ targetUserId: 1, createdAt: -1 });
// "Show me every read taken under support case X."
AdminSupportAccessAuditLogSchema.index({ supportCase: 1, createdAt: -1 });
AdminSupportAccessAuditLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AdminSupportAccessAuditLog: IAdminSupportAccessAuditLogModel =
  (mongoose.models.AdminSupportAccessAuditLog as IAdminSupportAccessAuditLogModel) ??
  model<IAdminSupportAccessAuditLogDocument>('AdminSupportAccessAuditLog', AdminSupportAccessAuditLogSchema);

class AdminSupportAccessAuditLogRepository
  extends BaseRepository<IAdminSupportAccessAuditLogDocument>
  implements IAdminSupportAccessAuditLogRepository
{
  constructor(private auditLogModel: IAdminSupportAccessAuditLogModel) {
    super(auditLogModel);
  }

  async record(
    event: Omit<IAdminSupportAccessAuditLog, 'createdAt' | 'expiresAt'>
  ): Promise<IAdminSupportAccessAuditLogDocument> {
    const created = await this.auditLogModel.create({
      ...event,
      expiresAt: new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000),
    });
    return created.toJSON() as unknown as IAdminSupportAccessAuditLogDocument;
  }
}

export const adminSupportAccessAuditLogRepository = new AdminSupportAccessAuditLogRepository(
  AdminSupportAccessAuditLog
);
