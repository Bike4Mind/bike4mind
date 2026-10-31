import mongoose, { Model, model, Schema, Types } from 'mongoose';
import {
  ADMIN_AUDIT_CREDIT_GRANT_ACTIONS,
  IMPERSONATION_ENDED_ACTION,
  IMPERSONATION_STARTED_ACTION,
  type AuditEntry,
  type AuditLogCursor,
  type AuditLogFilters,
  type AuditSummary,
  type IAdminAuditLogRepository,
  type NewAdminAuditEntry,
} from '@bike4mind/common';

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

// bulkWrite skips query middleware, so it needs its own guard.
AdminAuditLogSchema.pre('bulkWrite', throwImmutable);

AdminAuditLogSchema.pre('save', function () {
  if (!this.isNew) throwImmutable();
});

// Every index ends in _id so a filtered keyset page reads in index order without a blocking sort.
AdminAuditLogSchema.index({ occurredAt: -1, _id: -1 });
AdminAuditLogSchema.index({ 'actor.userId': 1, occurredAt: -1, _id: -1 });
AdminAuditLogSchema.index({ 'target.kind': 1, 'target.id': 1, occurredAt: -1, _id: -1 });
AdminAuditLogSchema.index({ organizationId: 1, occurredAt: -1, _id: -1 });
AdminAuditLogSchema.index({ category: 1, occurredAt: -1, _id: -1 });
AdminAuditLogSchema.index({ action: 1, occurredAt: -1, _id: -1 });
AdminAuditLogSchema.index({ severity: 1, occurredAt: -1, _id: -1 });
AdminAuditLogSchema.index(
  { 'context.requestId': 1, occurredAt: -1, _id: -1 },
  { partialFilterExpression: { 'context.requestId': { $exists: true } } }
);
AdminAuditLogSchema.index(
  { 'related.impersonationSessionId': 1, occurredAt: -1, _id: -1 },
  { partialFilterExpression: { 'related.impersonationSessionId': { $exists: true } } }
);

/** Indexes replaced by the _id-suffixed set above; the migration drops them by name. */
export const SUPERSEDED_ADMIN_AUDIT_INDEX_NAMES: readonly string[] = [
  'actor.userId_1_occurredAt_-1',
  'target.kind_1_target.id_1_occurredAt_-1',
  'organizationId_1_occurredAt_-1',
  'category_1_occurredAt_-1',
  'action_1_occurredAt_-1',
];

export const AdminAuditLogModel: Model<AdminAuditLogRecord> =
  (mongoose.models.AdminAuditLog as unknown as Model<AdminAuditLogRecord>) ??
  model<AdminAuditLogRecord>('AdminAuditLog', AdminAuditLogSchema);

type StoredRecord = AdminAuditLogRecord & { _id: Types.ObjectId };

const toAuditEntry = (record: StoredRecord): AuditEntry => {
  const { _id, ...rest } = record;
  return { ...rest, id: _id.toString(), source: 'admin' };
};

const OBJECT_ID_HEX_PATTERN = /^[0-9a-f]{24}$/i;
const TOP_GRANTER_LIMIT = 3;
// An unindexed filter combination fails fast rather than tying up the request until the gateway gives up.
const LIST_QUERY_MAX_TIME_MS = 15_000;

type FilterClause = Record<string, unknown>;

const buildFilterClauses = (filters: AuditLogFilters): FilterClause[] => {
  const clauses: FilterClause[] = [];
  const equals = (field: string, value: string | undefined) => {
    if (value !== undefined) clauses.push({ [field]: value });
  };

  equals('category', filters.category);
  equals('severity', filters.severity);
  equals('action', filters.action);
  equals('actor.userId', filters.actorUserId);
  equals('target.kind', filters.targetKind);
  equals('target.id', filters.targetId);
  equals('context.source', filters.source);
  equals('actor.scope', filters.actorScope);
  equals('context.requestId', filters.requestId);
  equals('related.impersonationSessionId', filters.impersonationSessionId);
  // The schema restricts verb to [a-z_], so it needs no regex escaping.
  if (filters.verb !== undefined) clauses.push({ action: { $regex: `\\.${filters.verb}$` } });
  if (filters.from !== undefined) clauses.push({ occurredAt: { $gte: new Date(filters.from) } });
  if (filters.to !== undefined) clauses.push({ occurredAt: { $lte: new Date(filters.to) } });
  return clauses;
};

// The redundant range bound lets the planner seek the occurredAt index instead of evaluating the $or alone.
const buildCursorClauses = (cursor: AuditLogCursor): FilterClause[] => [
  { occurredAt: { $lte: cursor.occurredAt } },
  {
    $or: [
      { occurredAt: { $lt: cursor.occurredAt } },
      { occurredAt: cursor.occurredAt, _id: { $lt: new Types.ObjectId(cursor.id) } },
    ],
  },
];

// Ascending twin of buildCursorClauses: strictly after the cursor in (occurredAt, _id) order.
const buildAfterCursorClauses = (cursor: AuditLogCursor): FilterClause[] => [
  { occurredAt: { $gte: cursor.occurredAt } },
  {
    $or: [
      { occurredAt: { $gt: cursor.occurredAt } },
      { occurredAt: cursor.occurredAt, _id: { $gt: new Types.ObjectId(cursor.id) } },
    ],
  },
];

const creditGrantsBy = (actorUserId: string): FilterClause => ({
  'actor.userId': actorUserId,
  action: { $in: ADMIN_AUDIT_CREDIT_GRANT_ACTIONS },
  'details.credits': { $gt: 0 },
});

type SummaryFacets = {
  grantCount: Array<{ count: number }>;
  creditTotals: Array<{ granted: number; deducted: number }>;
  topGranters: Array<{ _id: string | null; name: string; count: number }>;
  permissionChanges: Array<{ count: number }>;
  impersonations: Array<{ count: number }>;
  deletions: Array<{ count: number }>;
  deniedAttempts: Array<{ count: number }>;
};

const facetCount = (match: FilterClause) => [{ $match: match }, { $count: 'count' }];
const readCount = (facet: Array<{ count: number }> | undefined): number => facet?.[0]?.count ?? 0;

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

  async list(
    filters: AuditLogFilters,
    page: { limit: number; cursor?: AuditLogCursor }
  ): Promise<{ entries: AuditEntry[]; nextCursor: AuditLogCursor | null }> {
    return this.listPage(buildFilterClauses(filters), page);
  }

  async listForSubscription(
    scope: { owner: { kind: 'user' | 'organization'; id: string }; subscriptionIds: string[] },
    page: { limit: number; cursor?: AuditLogCursor }
  ): Promise<{ entries: AuditEntry[]; nextCursor: AuditLogCursor | null }> {
    const { owner, subscriptionIds } = scope;
    const ownerClause: FilterClause =
      owner.kind === 'user'
        ? { 'target.kind': 'user', 'target.id': owner.id }
        : { $or: [{ organizationId: owner.id }, { 'target.kind': 'organization', 'target.id': owner.id }] };
    return this.listPage([ownerClause, { 'details.subscriptionId': { $in: subscriptionIds } }], page);
  }

  private async listPage(
    baseClauses: FilterClause[],
    page: { limit: number; cursor?: AuditLogCursor }
  ): Promise<{ entries: AuditEntry[]; nextCursor: AuditLogCursor | null }> {
    const clauses = [...baseClauses];
    if (page.cursor) clauses.push(...buildCursorClauses(page.cursor));

    const records = await this.auditLogModel
      .find(clauses.length > 0 ? { $and: clauses } : {})
      .sort({ occurredAt: -1, _id: -1 })
      .limit(page.limit + 1)
      .maxTimeMS(LIST_QUERY_MAX_TIME_MS)
      .lean<StoredRecord[]>();

    const pageRecords = records.slice(0, page.limit);
    const last = pageRecords[pageRecords.length - 1];
    const nextCursor =
      records.length > page.limit && last ? { occurredAt: last.occurredAt, id: last._id.toString() } : null;
    return { entries: pageRecords.map(toAuditEntry), nextCursor };
  }

  async findById(id: string): Promise<AuditEntry | null> {
    if (!OBJECT_ID_HEX_PATTERN.test(id)) return null;
    const record = await this.auditLogModel.findById(id).lean<StoredRecord>();
    return record ? toAuditEntry(record) : null;
  }

  async summarize(since: Date): Promise<Omit<AuditSummary, 'windowDays' | 'since'>> {
    // A denied attempt moved nothing, so it is neither a grant nor part of the totals.
    const creditGrants = { category: 'credits', action: { $not: /\.denied$/ } };
    const signedCredits = { $convert: { input: '$details.credits', to: 'double', onError: 0, onNull: 0 } };
    const [facets] = await this.auditLogModel
      .aggregate<SummaryFacets>([
        { $match: { occurredAt: { $gte: since } } },
        {
          $facet: {
            grantCount: facetCount(creditGrants),
            creditTotals: [
              { $match: creditGrants },
              {
                $group: {
                  _id: null,
                  granted: { $sum: { $max: [signedCredits, 0] } },
                  deducted: { $sum: { $abs: { $min: [signedCredits, 0] } } },
                },
              },
            ],
            topGranters: [
              { $match: creditGrants },
              { $group: { _id: '$actor.userId', name: { $first: '$actor.name' }, count: { $sum: 1 } } },
              { $sort: { count: -1, _id: 1 } },
              { $limit: TOP_GRANTER_LIMIT },
            ],
            permissionChanges: facetCount({
              category: 'access',
              action: { $nin: [IMPERSONATION_STARTED_ACTION, IMPERSONATION_ENDED_ACTION] },
            }),
            impersonations: facetCount({ action: IMPERSONATION_STARTED_ACTION }),
            deletions: facetCount({ action: { $regex: '\\.deleted$' } }),
            deniedAttempts: facetCount({ action: { $regex: '\\.denied$' } }),
          },
        },
      ])
      .option({ maxTimeMS: LIST_QUERY_MAX_TIME_MS });

    return {
      creditGrants: {
        count: readCount(facets?.grantCount),
        grantedCredits: facets?.creditTotals?.[0]?.granted ?? 0,
        deductedCredits: facets?.creditTotals?.[0]?.deducted ?? 0,
        topGranters: (facets?.topGranters ?? []).map(({ _id, name, count }) => ({ userId: _id ?? null, name, count })),
      },
      permissionChanges: readCount(facets?.permissionChanges),
      impersonations: readCount(facets?.impersonations),
      deletions: readCount(facets?.deletions),
      deniedAttempts: readCount(facets?.deniedAttempts),
    };
  }

  async listAscending(page: { after: AuditLogCursor | null; until: Date; limit: number }): Promise<AuditEntry[]> {
    const clauses: FilterClause[] = [{ occurredAt: { $lte: page.until } }];
    if (page.after) clauses.push(...buildAfterCursorClauses(page.after));
    const records = await this.auditLogModel
      .find({ $and: clauses })
      .sort({ occurredAt: 1, _id: 1 })
      .limit(page.limit)
      .maxTimeMS(LIST_QUERY_MAX_TIME_MS)
      .lean<StoredRecord[]>();
    return records.map(toAuditEntry);
  }

  async countCreditGrants(actorUserId: string, window: { from: Date; to: Date }): Promise<number> {
    return this.auditLogModel
      .countDocuments({ ...creditGrantsBy(actorUserId), occurredAt: { $gt: window.from, $lte: window.to } })
      .maxTimeMS(LIST_QUERY_MAX_TIME_MS);
  }

  async sumCreditsGranted(actorUserId: string, since: Date): Promise<number> {
    const [total] = await this.auditLogModel
      .aggregate<{ credits: number }>([
        { $match: { ...creditGrantsBy(actorUserId), occurredAt: { $gte: since } } },
        { $group: { _id: null, credits: { $sum: '$details.credits' } } },
      ])
      .option({ maxTimeMS: LIST_QUERY_MAX_TIME_MS });
    return total?.credits ?? 0;
  }

  async appendBackfill(
    entries: Array<NewAdminAuditEntry & { id: string }>
  ): Promise<{ inserted: number; duplicates: number }> {
    if (entries.length === 0) return { inserted: 0, duplicates: 0 };

    const docs = entries.map(({ id, ...entry }) => ({ ...entry, _id: new Types.ObjectId(id) }));
    // Validate up front: on a re-run, duplicate-key errors would otherwise mask an invalid row from the same batch.
    for (const doc of docs) {
      await new this.auditLogModel(doc).validate();
    }
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
