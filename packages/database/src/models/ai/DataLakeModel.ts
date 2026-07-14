import mongoose from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import type {
  IDataLakeDocument,
  IDataLakeRepository,
  IDataLakeBatchDocument,
  IDataLakeBatchRepository,
  IDataLakeBatchFile,
  BatchFileStatus,
  BatchStatus,
  BatchCounterField,
  AccessContext,
  DataLakeStatus,
} from '@bike4mind/common';
import { BATCH_NON_TERMINAL_STATUSES, normalizeEntitlementKey } from '@bike4mind/common';

const DATA_LAKE_STATUSES: DataLakeStatus[] = [
  'draft',
  'active',
  'archiving',
  'archived',
  'restoring',
  'deleting',
  'deleted',
];

// --- Data Lake Schema ---

const DataLakeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    // Slug uniqueness is scoped per organization (compound index below), NOT global,
    // so two orgs may share a slug. Org-less lakes (organizationId missing) collide
    // with each other on slug - this is the desired behavior.
    slug: { type: String, required: true },
    description: { type: String },
    fileTagPrefix: { type: String, required: true },
    datalakeTag: { type: String, required: true },
    requiredUserTag: { type: String },
    // Generic entitlement gate (see IDataLake.requiredEntitlement). No dedicated index:
    // the lakes collection is tiny (a handful of docs) so a collscan beats index-union on
    // the two-clause $or in findActiveByUserTagsAndEntitlements.
    // Normalized at the SCHEMA layer (setter) so EVERY write path - service code, the stamp
    // script, direct repo.create/save, fixtures - persists a canonical lowercase key. The
    // entitlement-key $in query is case-sensitive, so an un-normalized stored value would
    // silently never match. The query side normalizes keys identically.
    requiredEntitlement: {
      type: String,
      set: (v: unknown) => (typeof v === 'string' ? normalizeEntitlementKey(v) : v),
    },
    createdByUserId: { type: String, required: true },
    organizationId: { type: String },
    // Public opt-in (see IDataLake.isPublic): a true value makes the lake readable app-wide,
    // bypassing the org prerequisite + Private-by-default. No dedicated index (tiny collection,
    // same rationale as requiredEntitlement); the public arm in the access filters keys off it.
    isPublic: { type: Boolean, default: false },
    status: { type: String, enum: DATA_LAKE_STATUSES, default: 'draft' },
    fileCount: { type: Number, default: 0 },
    totalSizeBytes: { type: Number, default: 0 },
    lastSyncAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Performance indexes
DataLakeSchema.index({ requiredUserTag: 1, status: 1 });
DataLakeSchema.index({ organizationId: 1, status: 1 });
DataLakeSchema.index({ createdByUserId: 1 });
// The meta-tag is the join key - globally unique.
DataLakeSchema.index({ datalakeTag: 1 }, { unique: true, sparse: true });
// Slug is unique PER SCOPE (org). Replaces the former global unique on `slug`.
// NOTE: deploying this requires dropping the legacy `slug_1` unique index in Mongo.
DataLakeSchema.index({ organizationId: 1, slug: 1 }, { unique: true });

export const DataLakeModel =
  (mongoose.models['DataLake'] as unknown as mongoose.Model<IDataLakeDocument>) ||
  mongoose.model<IDataLakeDocument>('DataLake', DataLakeSchema);

class DataLakeRepository extends BaseRepository<IDataLakeDocument> implements IDataLakeRepository {
  constructor(private dataLakeModel: mongoose.Model<IDataLakeDocument>) {
    super(dataLakeModel);
  }

  async findBySlug(slug: string, organizationId?: string): Promise<IDataLakeDocument | null> {
    // Slug is unique per (organizationId, slug). Prefer the caller's own-org lake,
    // then fall back to an org-less lake with the same slug - deterministic, so the
    // 404 outcome reflects the caller's scope, not arbitrary document order.
    if (organizationId) {
      const own = await this.dataLakeModel.findOne({ slug, organizationId });
      if (own) return own.toJSON() as IDataLakeDocument;
    }
    const orgless = await this.dataLakeModel.findOne({ slug, organizationId: { $in: [null, ''] } });
    return (orgless?.toJSON() as IDataLakeDocument) ?? null;
  }

  async findByDatalakeTag(datalakeTag: string): Promise<IDataLakeDocument | null> {
    // datalakeTag carries a globally-unique index, so at most one lake matches.
    const doc = await this.dataLakeModel.findOne({ datalakeTag });
    return (doc?.toJSON() as IDataLakeDocument) ?? null;
  }

  /**
   * Returns active data lakes the user can access: those matching any of the
   * user's tags (case-insensitive), plus any with no requiredUserTag restriction.
   * The null/$exists/empty-string arms cover all representations of "no restriction."
   */
  async findActiveByUserTags(userTags: string[]): Promise<IDataLakeDocument[]> {
    const normalizedTags = userTags.map(t => t.toLowerCase());
    const allTags = Array.from(new Set(userTags.concat(normalizedTags)));
    const results = await this.dataLakeModel.find({
      status: 'active',
      $or: [{ requiredUserTag: { $in: allTags } }, { requiredUserTag: null }, { requiredUserTag: '' }],
    });
    return results.map(r => r.toJSON() as IDataLakeDocument);
  }

  /**
   * Entitlement-aware variant of findActiveByUserTags. Returns active lakes the user can
   * reach by a matching requiredUserTag OR a matching requiredEntitlement, plus lakes with
   * NO restriction at all (BOTH fields null/empty). Mirrors the pure getAccessibleDataLakes
   * rule so the DB pre-filter and the in-memory filter agree - an entitlement-only lake is
   * NOT returned to a user lacking the key (the both-empty arm requires both fields blank).
   */
  async findActiveByUserTagsAndEntitlements(
    userTags: string[],
    entitlementKeys: string[],
    organizationId?: string | null,
    userId?: string | null
  ): Promise<IDataLakeDocument[]> {
    const normalizedTags = userTags.map(t => t.toLowerCase());
    const allTags = Array.from(new Set(userTags.concat(normalizedTags)));
    // Use the ONE canonical normalization rule (shared with the in-memory filter + write
    // path) so stored values and query keys can't drift.
    const keys = (entitlementKeys ?? []).map(normalizeEntitlementKey);

    // Non-owner grants, each evaluated under the org prerequisite below. A non-owner reaches
    // a lake only when it grants them something - a held tag, a held entitlement, or (for a
    // gateless ORG lake) membership in its org. A gateless, org-less lake grants nothing here,
    // so it resolves ONLY via the owner bypass -> Private-by-default, not world-readable.
    const nonOwnerArms: Record<string, unknown>[] = [{ requiredUserTag: { $in: allTags } }];
    if (organizationId) {
      // Gateless lake (no tag, no entitlement) scoped to the caller's org -> the org is its grant.
      nonOwnerArms.push({
        $and: [
          { $or: [{ requiredUserTag: null }, { requiredUserTag: '' }] },
          { $or: [{ requiredEntitlement: null }, { requiredEntitlement: '' }] },
          { organizationId },
        ],
      });
    }
    // Only add the entitlement arm when there are keys - `$in: []` is a harmless no-match
    // but `$in: undefined` throws, so guard explicitly.
    if (keys.length > 0) {
      nonOwnerArms.push({ requiredEntitlement: { $in: keys } });
    }

    // Org prerequisite (hard): org-less lakes OR lakes in the caller's org. null/'' form for
    // DocumentDB safety. Combined with the grants via $and - two top-level $or keys collide.
    const orgConstraint = organizationId
      ? { $or: [{ organizationId: null }, { organizationId: '' }, { organizationId }] }
      : { $or: [{ organizationId: null }, { organizationId: '' }] };

    const accessArms: Record<string, unknown>[] = [{ $and: [orgConstraint, { $or: nonOwnerArms }] }];

    // Public arm (mirrors findAccessible): an isPublic lake is reachable app-wide - it bypasses
    // the org prerequisite AND Private-by-default. The requirement gate is STILL enforced
    // (both-blank OR held tag OR held key), so a gate added after publishing keeps holding; a
    // normal public lake is gate-less and matches the both-blank sub-arm.
    const publicRequirementOr: Record<string, unknown>[] = [
      {
        $and: [
          { $or: [{ requiredUserTag: null }, { requiredUserTag: '' }] },
          { $or: [{ requiredEntitlement: null }, { requiredEntitlement: '' }] },
        ],
      },
      { requiredUserTag: { $in: allTags } },
    ];
    if (keys.length > 0) publicRequirementOr.push({ requiredEntitlement: { $in: keys } });
    accessArms.push({ $and: [{ isPublic: true }, { $or: publicRequirementOr }] });

    // Owner bypass (mirrors findAccessible): the creator always retrieves their own lakes,
    // including private gateless ones. Only when a userId is supplied.
    if (userId) accessArms.unshift({ createdByUserId: userId });

    const results = await this.dataLakeModel.find({ status: 'active', $or: accessArms });
    return results.map(r => r.toJSON() as IDataLakeDocument);
  }

  async findByOrganizationId(orgId: string): Promise<IDataLakeDocument[]> {
    const results = await this.dataLakeModel.find({ organizationId: orgId });
    return results.map(r => r.toJSON() as IDataLakeDocument);
  }

  /**
   * Datastore-side accessibility filter mirroring the single access gate:
   * owner OR (org-constraint AND requirement-constraint AND not-private). The org and
   * requirement arms are ANDed for non-owners, so a tag/entitlement-holder in a different
   * org never receives the lake. The requirement arm is the Mongo mirror of the in-memory
   * `lakeMatchesAccess` any-of (shared with findActiveByUserTagsAndEntitlements).
   *
   * "Private" = a lake with NO org and NO gate (requiredUserTag/requiredEntitlement all
   * blank). Such a lake is owner/admin-only - it is NOT world-readable. A non-owner reaches
   * a lake only when it grants them something: their org (org-scoped lake) or a gate they
   * hold. This is the Private-by-default rule; the owner still matches via the separate arm.
   */
  async findAccessible(
    ctx: AccessContext,
    opts?: { statuses?: DataLakeStatus[]; includePublic?: boolean }
  ): Promise<IDataLakeDocument[]> {
    const statuses = opts?.statuses ?? (['draft', 'active'] as DataLakeStatus[]);
    // Public lakes belong in the browse/read list, NOT the archived/deleted MANAGEMENT views:
    // restore/cleanup are owner/admin-only, so a stranger has no role on someone else's public
    // lake there. Those views pass includePublic:false; the owner still sees their own via the
    // owner arm, and org members keep org lakes via the org arm (pre-existing, intended).
    const includePublic = opts?.includePublic ?? true;
    const normalizedTags = ctx.userTags.map(t => t.toLowerCase());
    const allTags = Array.from(new Set(ctx.userTags.concat(normalizedTags)));
    // Use the ONE canonical normalization (shared with the in-memory filter + write path).
    const keys = (ctx.entitlementKeys ?? []).map(normalizeEntitlementKey);

    // Org constraint: lake has no org OR the lake's org matches the user's org.
    const orgConstraint = ctx.organizationId
      ? { $or: [{ organizationId: { $in: [null, ''] } }, { organizationId: ctx.organizationId }] }
      : { organizationId: { $in: [null, ''] } };

    // Requirement constraint (mirror of `lakeMatchesAccess`): the lake has NO restriction
    // (BOTH requiredUserTag AND requiredEntitlement blank), OR the user holds the required
    // tag, OR the user holds the required entitlement. Requiring BOTH blank for the "no
    // restriction" arm is what keeps an entitlement-only lake from leaking via the legacy
    // blank-tag arm. Per-arm null/'' form (not `$in:[null]`) for DocumentDB safety, matching
    // findActiveByUserTagsAndEntitlements.
    const requirementOr: Record<string, unknown>[] = [
      {
        $and: [
          { $or: [{ requiredUserTag: null }, { requiredUserTag: '' }] },
          { $or: [{ requiredEntitlement: null }, { requiredEntitlement: '' }] },
        ],
      },
      { requiredUserTag: { $in: allTags } },
    ];
    // Guard: `$in: []` is a harmless no-match but `$in: undefined` throws.
    if (keys.length > 0) {
      requirementOr.push({ requiredEntitlement: { $in: keys } });
    }
    const requirementConstraint = { $or: requirementOr };

    // Not-private: exclude lakes with no org AND no gate at all. Such a lake grants a
    // non-owner nothing, so it must stay owner-only rather than read-by-anyone. Uses the
    // null/'' form + $nor (DocumentDB-safe) consistent with the rest of this model.
    const notPrivate = {
      $nor: [
        {
          $and: [
            { $or: [{ organizationId: null }, { organizationId: '' }] },
            { $or: [{ requiredUserTag: null }, { requiredUserTag: '' }] },
            { $or: [{ requiredEntitlement: null }, { requiredEntitlement: '' }] },
          ],
        },
      ],
    };

    // Public arm: an isPublic lake is accessible app-wide - it bypasses the org prerequisite
    // AND the not-private exclusion (a public gateless lake IS meant to be world-readable). The
    // requirement constraint is still ANDed as defense in depth, so a gate added after publishing
    // keeps holding while a normal (gate-less) public lake passes via requirementConstraint's
    // both-blank arm.
    const publicArm = { $and: [{ isPublic: true }, requirementConstraint] };

    // Non-owner arms: the org/gate arm always applies; the public arm only in browse/read views
    // (dropped for management views via includePublic - see the note at the top of this method).
    const nonOwnerArms: Record<string, unknown>[] = [{ $and: [orgConstraint, requirementConstraint, notPrivate] }];
    if (includePublic) nonOwnerArms.unshift(publicArm);

    const filter: Record<string, unknown> = ctx.isAdmin
      ? { status: { $in: statuses } }
      : {
          status: { $in: statuses },
          $or: [{ createdByUserId: ctx.userId }, ...nonOwnerArms],
        };

    const results = await this.dataLakeModel.find(filter);
    return results.map(r => r.toJSON() as IDataLakeDocument);
  }

  async setStats(id: string, stats: { fileCount: number; totalSizeBytes: number }): Promise<IDataLakeDocument | null> {
    const doc = await this.dataLakeModel.findByIdAndUpdate(
      id,
      { $set: { fileCount: stats.fileCount, totalSizeBytes: stats.totalSizeBytes, lastSyncAt: new Date() } },
      { new: true }
    );
    return (doc?.toJSON() as IDataLakeDocument) ?? null;
  }
}

export const dataLakeRepository = new DataLakeRepository(DataLakeModel);

// --- Data Lake Batch Schema ---

const DataLakeBatchFileSchema = new mongoose.Schema(
  {
    fabFileId: { type: String, required: true },
    fileName: { type: String, required: true },
    relativePath: { type: String },
    contentHash: { type: String },
    status: {
      type: String,
      enum: ['pending', 'uploaded', 'chunking', 'vectorizing', 'complete', 'failed', 'skipped'],
      default: 'pending',
    },
    error: { type: String },
  },
  { _id: false }
);

const DataLakeBatchSchema = new mongoose.Schema(
  {
    dataLakeId: { type: String, required: true },
    userId: { type: String, required: true },
    status: {
      type: String,
      enum: ['preparing', 'uploading', 'processing', 'completed', 'completed_with_errors', 'failed', 'cancelled'],
      default: 'preparing',
    },
    conflictResolution: { type: String, enum: ['skip', 'update', 'duplicate'], default: 'skip' },
    totalFiles: { type: Number, default: 0 },
    uploadedFiles: { type: Number, default: 0 },
    chunkedFiles: { type: Number, default: 0 },
    vectorizedFiles: { type: Number, default: 0 },
    failedFiles: { type: Number, default: 0 },
    failedFileNames: [{ type: String }],
    skippedFiles: { type: Number, default: 0 },
    totalSizeBytes: { type: Number, default: 0 },
    uploadedSizeBytes: { type: Number, default: 0 },
    files: [DataLakeBatchFileSchema],
    appliedTags: [
      {
        name: { type: String, required: true },
        strength: { type: Number, required: true },
        _id: false,
      },
    ],
    startedAt: { type: Date },
    completedAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Performance indexes
DataLakeBatchSchema.index({ userId: 1, status: 1 });
DataLakeBatchSchema.index({ dataLakeId: 1, status: 1 });
// Read-time reconciler scan: non-terminal batches ordered by staleness.
DataLakeBatchSchema.index({ status: 1, updatedAt: 1 });

const DataLakeBatchModel =
  (mongoose.models['DataLakeBatch'] as unknown as mongoose.Model<IDataLakeBatchDocument>) ||
  mongoose.model<IDataLakeBatchDocument>('DataLakeBatch', DataLakeBatchSchema);

class DataLakeBatchRepository extends BaseRepository<IDataLakeBatchDocument> implements IDataLakeBatchRepository {
  constructor(private batchModel: mongoose.Model<IDataLakeBatchDocument>) {
    super(batchModel);
  }

  async findActiveByUserId(userId: string): Promise<IDataLakeBatchDocument[]> {
    const results = await this.batchModel.find({
      userId,
      status: { $in: BATCH_NON_TERMINAL_STATUSES },
    });
    return results.map(r => r.toJSON() as IDataLakeBatchDocument);
  }

  async findActiveByDataLakeId(dataLakeId: string): Promise<IDataLakeBatchDocument[]> {
    const results = await this.batchModel.find({
      dataLakeId,
      status: { $in: BATCH_NON_TERMINAL_STATUSES },
    });
    return results.map(r => r.toJSON() as IDataLakeBatchDocument);
  }

  async updateFileStatus(batchId: string, fabFileId: string, status: BatchFileStatus, error?: string): Promise<void> {
    const update: Record<string, unknown> = { 'files.$.status': status };
    if (error) update['files.$.error'] = error;

    await this.batchModel.updateOne({ _id: batchId, 'files.fabFileId': fabFileId }, { $set: update });
  }

  async appendFiles(batchId: string, files: IDataLakeBatchFile[]): Promise<void> {
    if (files.length === 0) return;
    await this.batchModel.updateOne({ _id: batchId }, { $push: { files: { $each: files } } });
  }

  /**
   * Atomic file claim: transition a manifest file from one of `from` to `to`,
   * succeeding only if the file is currently in a `from` state. `modifiedCount === 1`
   * means THIS caller won - the redelivery-safety primitive that gates the counter
   * increment so a re-delivered message is a true no-op.
   */
  async claimFileStatus(
    batchId: string,
    fabFileId: string,
    from: BatchFileStatus[],
    to: BatchFileStatus
  ): Promise<boolean> {
    const res = await this.batchModel.updateOne(
      { _id: batchId, files: { $elemMatch: { fabFileId, status: { $in: from } } } },
      { $set: { 'files.$.status': to } }
    );
    return res.modifiedCount === 1;
  }

  async incrementCounter(
    batchId: string,
    field: BatchCounterField,
    amount: number = 1
  ): Promise<IDataLakeBatchDocument | null> {
    const doc = await this.batchModel.findOneAndUpdate({ _id: batchId }, { $inc: { [field]: amount } }, { new: true });
    return doc?.toJSON() as IDataLakeBatchDocument | null;
  }

  /**
   * Guarded terminal transition: only succeeds if the batch is still non-terminal,
   * so exactly one caller wins the finalization (the completion-crossing increment
   * OR the reconciler), never both. Returns the post-update doc to the winner.
   */
  async markTerminalIfActive(
    batchId: string,
    status: Extract<BatchStatus, 'completed' | 'completed_with_errors' | 'failed' | 'cancelled'>
  ): Promise<IDataLakeBatchDocument | null> {
    const doc = await this.batchModel.findOneAndUpdate(
      { _id: batchId, status: { $in: BATCH_NON_TERMINAL_STATUSES } },
      { $set: { status, completedAt: new Date() } },
      { new: true }
    );
    return (doc?.toJSON() as IDataLakeBatchDocument) ?? null;
  }
}

export const dataLakeBatchRepository = new DataLakeBatchRepository(DataLakeBatchModel);
