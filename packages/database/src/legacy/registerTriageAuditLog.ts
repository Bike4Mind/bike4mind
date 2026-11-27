import mongoose, { Schema, Types } from 'mongoose';

/** Retained audit history for the retired feature; registration keeps account erasure effective. */
type LegacyAuditEntry = {
  configId: Types.ObjectId;
  configName: string;
  action: 'create' | 'update' | 'delete' | 'enable' | 'disable' | 'trigger';
  userId: string;
  userName: string;
  changes?: Map<string, unknown>;
  timestamp: Date;
};

const legacyAuditSchema = new Schema<LegacyAuditEntry>(
  {
    configId: { type: Schema.Types.ObjectId, required: true },
    configName: { type: String, required: true },
    action: { type: String, required: true, enum: ['create', 'update', 'delete', 'enable', 'disable', 'trigger'] },
    userId: { type: String, required: true },
    userName: { type: String, required: true },
    changes: { type: Map, of: Schema.Types.Mixed },
    timestamp: { type: Date, required: true, default: Date.now },
  },
  {
    collection: 'liveopstriageconfigauditlogs',
    versionKey: false,
    autoCreate: false,
    autoIndex: false,
  }
);

// Preserve the existing retention contract without rebuilding or dropping historical indexes.
legacyAuditSchema.index({ timestamp: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

if (!mongoose.models.LiveopsTriageConfigAuditLog) {
  mongoose.model<LegacyAuditEntry>('LiveopsTriageConfigAuditLog', legacyAuditSchema);
}
