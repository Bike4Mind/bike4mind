import mongoose, { Model, Schema } from 'mongoose';
import type { DataLakeStatus, LakeMemoryState, PredicateTally } from '@bike4mind/common';
import { IMongoDocument } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'DataLakeHealthSnapshot';

/**
 * How long a trend point is kept. The sweep writes one row per active lake per day forever, so
 * without a TTL this collection only grows - same reason LakeAccessEventModel and
 * DataLakeSpendNotificationModel carry one. A year of daily points is well past any window a
 * "is this lake degrading" question is asked over.
 */
export const DATA_LAKE_HEALTH_SNAPSHOT_RETENTION_DAYS = 365;

/** A quarter of daily points - enough to read a trend, bounded for a caller that names no limit. */
const DEFAULT_TREND_LIMIT = 90;

/**
 * One row per (lake, day): the scheduled sweep's persisted trend of `computeLakeHealth`'s
 * output, so a degrading lake is visible without anyone asking. Deliberately a SUMMARY, not the
 * full `LakeHealthApiResponse` - `affectedMembers`/`membership`/`duplicateMembers.groups` carry
 * per-file drill-down data that belongs to the on-demand GET /health route, not a row written for
 * every active lake every day. See `computeLakeHealth` for how every field here is derived.
 */
export interface IDataLakeHealthSnapshotDocument extends IMongoDocument {
  lakeId: string;
  organizationId: string | null;
  /** UTC calendar day (`YYYY-MM-DD`) the sweep computed this on. Paired with `lakeId` as the
   * idempotency key - see the unique index below - so a retried or re-run sweep overwrites the
   * same day's row instead of accumulating duplicates. */
  snapshotDate: string;
  computedAt: Date;
  status: DataLakeStatus;
  servesRetrieval: boolean;
  reachableShare: number | null;
  measuredMembers: number;
  membersWithChunks: number;
  predicates: {
    chunkWithinPolicy: PredicateTally;
    chunkCountConsistent: PredicateTally;
    fullyVectorized: PredicateTally;
  };
  serveCapMeetsPolicy: boolean;
  affectedMemberCount: number;
  scanTruncated: boolean;
  duplicateMemberCount: number;
  duplicateGroupCount: number;
  lakeMemoryState: LakeMemoryState;
  /** Null means detection has never run for this lake - see `LakeHealthApiResponse.inconsistency`. */
  inconsistencyFindingCount: number | null;
  /** TTL sweep anchor; derived from `computedAt`, never supplied by the caller. */
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface IDataLakeHealthSnapshotModel extends Model<IDataLakeHealthSnapshotDocument> {}

const PredicateTallySchema = {
  pass: { type: Number, required: true },
  fail: { type: Number, required: true },
  unknown: { type: Number, required: true },
};

const DataLakeHealthSnapshotSchema = new Schema<IDataLakeHealthSnapshotDocument>(
  {
    lakeId: { type: String, required: true },
    organizationId: { type: String, default: null },
    snapshotDate: { type: String, required: true },
    computedAt: { type: Date, required: true },
    status: { type: String, required: true },
    servesRetrieval: { type: Boolean, required: true },
    reachableShare: { type: Number, default: null },
    measuredMembers: { type: Number, required: true },
    membersWithChunks: { type: Number, required: true },
    predicates: {
      chunkWithinPolicy: PredicateTallySchema,
      chunkCountConsistent: PredicateTallySchema,
      fullyVectorized: PredicateTallySchema,
    },
    serveCapMeetsPolicy: { type: Boolean, required: true },
    affectedMemberCount: { type: Number, required: true },
    scanTruncated: { type: Boolean, required: true, default: false },
    duplicateMemberCount: { type: Number, required: true },
    duplicateGroupCount: { type: Number, required: true },
    lakeMemoryState: { type: String, required: true },
    inconsistencyFindingCount: { type: Number, default: null },
    expiresAt: { type: Date, required: true, immutable: true },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

// The idempotency key (lakeId, snapshotDate) doubles as the trend query's own access path: it is
// already sorted by snapshotDate within a lake, so getTrend needs no second index.
DataLakeHealthSnapshotSchema.index({ lakeId: 1, snapshotDate: 1 }, { unique: true });
DataLakeHealthSnapshotSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const DataLakeHealthSnapshotModel: IDataLakeHealthSnapshotModel =
  (mongoose.models[ModelName] as IDataLakeHealthSnapshotModel) ||
  mongoose.model<IDataLakeHealthSnapshotDocument, IDataLakeHealthSnapshotModel>(
    ModelName,
    DataLakeHealthSnapshotSchema
  );

class DataLakeHealthSnapshotRepository extends BaseRepository<IDataLakeHealthSnapshotDocument> {
  constructor(private snapshotModel: mongoose.Model<IDataLakeHealthSnapshotDocument>) {
    super(snapshotModel);
  }

  /**
   * Upsert on (lakeId, snapshotDate): a sweep retried the same day (a Lambda retry, or a second
   * manual run) overwrites that day's row with the fresher computation instead of adding a
   * duplicate - the trend gains a new point once per day per lake, never more.
   */
  async upsertSnapshot(
    input: Omit<IDataLakeHealthSnapshotDocument, 'id' | 'createdAt' | 'updatedAt' | 'expiresAt'>
  ): Promise<void> {
    const expiresAt = new Date(
      input.computedAt.getTime() + DATA_LAKE_HEALTH_SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000
    );
    await this.snapshotModel.findOneAndUpdate(
      { lakeId: input.lakeId, snapshotDate: input.snapshotDate },
      { $set: { ...input, expiresAt } },
      { upsert: true, setDefaultsOnInsert: true }
    );
  }

  /** Newest first, bounded by default (a lake's history is one row per day and only TTL-capped, so
   * an unbounded read grows with the lake's age). Not read by anything shipped in this change;
   * exists so the persisted trend is actually queryable rather than write-only. */
  async getTrend(lakeId: string, opts?: { limit?: number }): Promise<IDataLakeHealthSnapshotDocument[]> {
    const query = this.snapshotModel.find({ lakeId }).sort({ snapshotDate: -1 });
    query.limit(opts?.limit ?? DEFAULT_TREND_LIMIT);
    const docs = await query;
    return docs.map(d => d.toJSON() as unknown as IDataLakeHealthSnapshotDocument);
  }
}

export const dataLakeHealthSnapshotRepository = new DataLakeHealthSnapshotRepository(DataLakeHealthSnapshotModel);
