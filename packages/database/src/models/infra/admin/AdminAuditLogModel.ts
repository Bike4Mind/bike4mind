import mongoose, { Model, model, Schema, Types } from 'mongoose';
import type { AuditEntry, IAdminAuditLogRepository, NewAdminAuditEntry } from '@bike4mind/common';

/** The stored shape: everything on an AuditEntry except `id` (virtual from `_id`) and `source` (read-side tag). */
export type AdminAuditLogRecord = Omit<AuditEntry, 'id' | 'source'>;

const IMMUTABLE_MESSAGE = 'AdminAuditLog entries are immutable';
const DUPLICATE_KEY_ERROR_CODE = 11000;

const ActorSchema = new Schema(
  {
    kind: { type: String, enum: ['user', 'apiKey', 'system', 'script'], required: true },
    scope: { type: String, enum: ['platform', 'organization'], required: true },
    userId: { type: String },
    apiKeyId: { type: String },
    email: { type: String },
    name: { type: String, required: true },
    wasAdmin: { type: Boolean, required: true },
    impersonatedUserId: { type: String },
  },
  { _id: false }
);

const TargetSchema = new Schema(
  {
    kind: {
      type: String,
      enum: ['user', 'organization', 'settings', 'oauthClient', 'apiKey', 'system'],
      required: true,
    },
    id: { type: String, required: true },
    displayName: { type: String, required: true },
  },
  { _id: false }
);

const ChangeSchema = new Schema(
  {
    field: { type: String, required: true },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
  },
  { _id: false }
);

const ContextSchema = new Schema(
  {
    ip: { type: String },
    userAgent: { type: String },
    requestId: { type: String },
    source: { type: String, enum: ['admin_ui', 'api_key', 'script', 'worker'], required: true },
    route: { type: String },
  },
  { _id: false }
);

const RelatedSchema = new Schema(
  {
    creditTransactionId: { type: String },
    impersonationSessionId: { type: String },
  },
  { _id: false }
);

const AdminAuditLogSchema = new Schema<AdminAuditLogRecord>(
  {
    occurredAt: { type: Date, required: true },
    action: { type: String, required: true },
    category: {
      type: String,
      enum: ['credits', 'access', 'identity', 'account', 'org', 'settings', 'support'],
      required: true,
    },
    severity: { type: String, enum: ['info', 'notice', 'critical'], required: true },
    actor: { type: ActorSchema, required: true },
    target: { type: TargetSchema, required: true },
    organizationId: { type: String },
    summary: { type: String, required: true },
    reason: { type: String },
    changes: { type: [ChangeSchema], default: undefined },
    details: { type: Schema.Types.Mixed },
    context: { type: ContextSchema, required: true },
    related: { type: RelatedSchema },
    backfilled: { type: Boolean },
  },
  {
    // The entry's own occurredAt is the time; createdAt/updatedAt would imply it can change.
    timestamps: false,
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

const throwImmutable = (): never => {
  throw new Error(IMMUTABLE_MESSAGE);
};

AdminAuditLogSchema.pre(
  [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'replaceOne',
    'findOneAndReplace',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
  ],
  throwImmutable
);

AdminAuditLogSchema.pre('save', function () {
  if (!this.isNew) throwImmutable();
});

AdminAuditLogSchema.index({ occurredAt: -1, _id: -1 });
AdminAuditLogSchema.index({ 'actor.userId': 1, occurredAt: -1 });
AdminAuditLogSchema.index({ 'target.kind': 1, 'target.id': 1, occurredAt: -1 });
AdminAuditLogSchema.index({ organizationId: 1, occurredAt: -1 });
AdminAuditLogSchema.index({ category: 1, occurredAt: -1 });
AdminAuditLogSchema.index({ action: 1, occurredAt: -1 });

export const AdminAuditLogModel: Model<AdminAuditLogRecord> =
  (mongoose.models.AdminAuditLog as unknown as Model<AdminAuditLogRecord>) ??
  model<AdminAuditLogRecord>('AdminAuditLog', AdminAuditLogSchema);

type StoredRecord = AdminAuditLogRecord & { _id: Types.ObjectId };

const toAuditEntry = (record: StoredRecord): AuditEntry => {
  const { _id, ...rest } = record;
  return { ...rest, id: _id.toString(), source: 'admin' };
};

const hasWriteErrors = (error: unknown): error is { writeErrors: unknown[] } =>
  typeof error === 'object' && error !== null && 'writeErrors' in error && Array.isArray(error.writeErrors);

const hasValidationErrors = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'validationErrors' in error && Array.isArray(error.validationErrors)
    ? error.validationErrors.length > 0
    : false;

/** Bulk write errors expose the code directly or under `err`, depending on the driver path. */
const writeErrorCode = (writeError: unknown): unknown => {
  if (typeof writeError !== 'object' || writeError === null) return undefined;
  if ('code' in writeError) return writeError.code;
  if (
    'err' in writeError &&
    typeof writeError.err === 'object' &&
    writeError.err !== null &&
    'code' in writeError.err
  ) {
    return writeError.err.code;
  }
  return undefined;
};

class AdminAuditLogRepository implements IAdminAuditLogRepository {
  constructor(private readonly auditLogModel: Model<AdminAuditLogRecord>) {}

  async append(entry: NewAdminAuditEntry): Promise<AuditEntry> {
    const created = await this.auditLogModel.create(entry);
    return toAuditEntry(created.toObject({ virtuals: false }) as unknown as StoredRecord);
  }

  async appendBackfill(
    entries: Array<NewAdminAuditEntry & { id: string }>
  ): Promise<{ inserted: number; duplicates: number }> {
    if (entries.length === 0) return { inserted: 0, duplicates: 0 };

    const docs = entries.map(({ id, ...entry }) => ({ ...entry, _id: new Types.ObjectId(id) }));
    try {
      await this.auditLogModel.insertMany(docs, { ordered: false, throwOnValidationError: true });
      return { inserted: docs.length, duplicates: 0 };
    } catch (error) {
      if (!hasWriteErrors(error) || hasValidationErrors(error)) throw error;
      const duplicates = error.writeErrors.filter(
        writeError => writeErrorCode(writeError) === DUPLICATE_KEY_ERROR_CODE
      ).length;
      // Anything other than a duplicate key means the batch is not safely idempotent; surface it.
      if (duplicates !== error.writeErrors.length) throw error;
      return { inserted: docs.length - duplicates, duplicates };
    }
  }
}

export const adminAuditLogRepository: IAdminAuditLogRepository = new AdminAuditLogRepository(AdminAuditLogModel);
