import mongoose, { AnyBulkWriteOperation, Model, Schema, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import {
  AI_USAGE_TRANSACTION_TYPES,
  CreditHolderType,
  IMongoDocument,
  ISpendRollup,
  ISpendRollupRepository,
  SPEND_BUCKET_MS,
  SPEND_ROLLUP_SCOPE_TYPES,
  SpendRollupScopeType,
} from '@bike4mind/common';
import { CreditTransaction } from './CreditTransactionModel';
import { UsageEvent } from './UsageEventModel';

export type ISpendRollupDocument = ISpendRollup & IMongoDocument;

const PLATFORM_SCOPE_ID = 'all';

// 35 days: the longest baseline window the detectors read, plus slack.
const SPEND_ROLLUP_TTL_SECONDS = 3024000;

const SpendRollupSchema = new Schema<ISpendRollupDocument>(
  {
    bucketStart: { type: Date, required: true },
    scopeType: { type: String, required: true, enum: [...SPEND_ROLLUP_SCOPE_TYPES] },
    scopeId: { type: String, required: true },
    credits: { type: Number, required: true, default: 0 },
    costUsd: { type: Number, required: true, default: 0 },
    creditsCharged: { type: Number, required: true, default: 0 },
    requests: { type: Number, required: true, default: 0 },
  },
  { timestamps: false }
);

SpendRollupSchema.index({ bucketStart: 1, scopeType: 1, scopeId: 1 }, { unique: true });
SpendRollupSchema.index({ scopeType: 1, scopeId: 1, bucketStart: -1 });
SpendRollupSchema.index({ bucketStart: 1 }, { expireAfterSeconds: SPEND_ROLLUP_TTL_SECONDS });

export type ISpendRollupModel = Model<ISpendRollupDocument>;

type Totals = Pick<ISpendRollup, 'credits' | 'costUsd' | 'creditsCharged' | 'requests'>;

type TotalsRow = Totals & { _id: string };

const emptyTotals = (): Totals => ({ credits: 0, costUsd: 0, creditsCharged: 0, requests: 0 });

/** Accumulates per-scope totals keyed by `${scopeType}\u0000${scopeId}`. */
class ScopeTotals {
  private readonly entries = new Map<string, { scopeType: SpendRollupScopeType; scopeId: string; totals: Totals }>();

  add(scopeType: SpendRollupScopeType, scopeId: string, delta: Partial<Totals>): void {
    const key = `${scopeType}\u0000${scopeId}`;
    const entry = this.entries.get(key) ?? { scopeType, scopeId, totals: emptyTotals() };
    entry.totals.credits += delta.credits ?? 0;
    entry.totals.costUsd += delta.costUsd ?? 0;
    entry.totals.creditsCharged += delta.creditsCharged ?? 0;
    entry.totals.requests += delta.requests ?? 0;
    this.entries.set(key, entry);
  }

  values() {
    return [...this.entries.values()];
  }
}

/**
 * The ownerType predicate lists every holder type so the { ownerType, createdAt, type } index on
 * CreditTransaction serves this scan; do not drop it as redundant.
 */
export const ledgerUsageMatch = (from: Date, to: Date) => ({
  ownerType: { $in: Object.values(CreditHolderType) },
  type: { $in: [...AI_USAGE_TRANSACTION_TYPES] },
  createdAt: { $gte: from, $lt: to },
});

const isNonZero = (totals: Totals): boolean =>
  totals.credits !== 0 || totals.costUsd !== 0 || totals.creditsCharged !== 0 || totals.requests !== 0;

export class SpendRollupRepository extends BaseRepository<ISpendRollupDocument> implements ISpendRollupRepository {
  constructor(model: ISpendRollupModel) {
    super(model);
  }

  async rollupBucket(bucketStart: Date): Promise<{ docs: number }> {
    if (bucketStart.getTime() % SPEND_BUCKET_MS !== 0) {
      throw new Error(`rollupBucket: ${bucketStart.toISOString()} is not on a bucket boundary`);
    }
    const bucketEnd = new Date(bucketStart.getTime() + SPEND_BUCKET_MS);
    const [ledgerFacets, usageFacets] = await Promise.all([
      this.aggregateLedger(bucketStart, bucketEnd),
      this.aggregateUsageEvents(bucketStart, bucketEnd),
    ]);

    const scopes = new ScopeTotals();
    // Written even when all zeros so latestBucketStart advances across quiet buckets.
    scopes.add('platform', PLATFORM_SCOPE_ID, {});
    for (const row of ledgerFacets.platform) {
      scopes.add('platform', PLATFORM_SCOPE_ID, { credits: row.credits, requests: row.requests });
    }
    for (const row of ledgerFacets.owner) {
      scopes.add(row._id.ownerType, row._id.ownerId, { credits: row.credits, requests: row.requests });
    }
    for (const row of ledgerFacets.apiKey) {
      scopes.add('apiKey', row._id, { credits: row.credits, requests: row.requests });
    }
    for (const row of ledgerFacets.model) {
      scopes.add('model', row._id, { credits: row.credits, requests: row.requests });
    }
    for (const row of usageFacets.platform) {
      scopes.add('platform', PLATFORM_SCOPE_ID, { costUsd: row.costUsd, creditsCharged: row.creditsCharged });
    }
    for (const row of usageFacets.model) {
      scopes.add('model', row._id, { costUsd: row.costUsd, creditsCharged: row.creditsCharged });
    }

    const operations: AnyBulkWriteOperation<ISpendRollupDocument>[] = scopes
      .values()
      .filter(({ scopeType, totals }) => scopeType === 'platform' || isNonZero(totals))
      .map(({ scopeType, scopeId, totals }) => ({
        updateOne: {
          filter: { bucketStart, scopeType, scopeId },
          update: { $set: totals },
          upsert: true,
        },
      }));

    await this.model.bulkWrite(operations, { ordered: false });
    return { docs: operations.length };
  }

  async latestBucketStart(): Promise<Date | null> {
    const latest = await this.model
      .findOne({ scopeType: 'platform', scopeId: PLATFORM_SCOPE_ID })
      .sort({ bucketStart: -1 })
      .lean();
    return latest?.bucketStart ?? null;
  }

  async sumWindow(
    scopeType: SpendRollupScopeType,
    from: Date,
    to: Date,
    scopeIds?: string[]
  ): Promise<Map<string, ISpendRollup>> {
    const rows = await this.model.aggregate<TotalsRow>([
      {
        $match: {
          scopeType,
          bucketStart: { $gte: from, $lt: to },
          ...(scopeIds ? { scopeId: { $in: scopeIds } } : {}),
        },
      },
      {
        $group: {
          _id: '$scopeId',
          credits: { $sum: '$credits' },
          costUsd: { $sum: '$costUsd' },
          creditsCharged: { $sum: '$creditsCharged' },
          requests: { $sum: '$requests' },
        },
      },
    ]);

    return new Map(
      rows.map(({ _id: scopeId, credits, costUsd, creditsCharged, requests }) => [
        scopeId,
        { bucketStart: from, scopeType, scopeId, credits, costUsd, creditsCharged, requests },
      ])
    );
  }

  async windowSeries(
    scopeType: SpendRollupScopeType,
    scopeIds: string[],
    from: Date,
    to: Date
  ): Promise<Map<string, ISpendRollup[]>> {
    const docs = await this.model
      .find({ scopeType, scopeId: { $in: scopeIds }, bucketStart: { $gte: from, $lt: to } })
      .sort({ bucketStart: 1 })
      .lean();

    const series = new Map<string, ISpendRollup[]>();
    for (const doc of docs) {
      const bucket = series.get(doc.scopeId) ?? [];
      bucket.push(doc);
      series.set(doc.scopeId, bucket);
    }
    return series;
  }

  private async aggregateLedger(from: Date, to: Date) {
    const group = (id: unknown) => ({
      $group: { _id: id, credits: { $sum: { $abs: '$credits' } }, requests: { $sum: 1 } },
    });
    const [facets] = await CreditTransaction.aggregate<{
      platform: Array<{ credits: number; requests: number }>;
      owner: Array<{
        _id: { ownerType: 'User' | 'Organization' | 'Agent'; ownerId: string };
        credits: number;
        requests: number;
      }>;
      apiKey: Array<{ _id: string; credits: number; requests: number }>;
      model: Array<{ _id: string; credits: number; requests: number }>;
    }>([
      {
        $match: ledgerUsageMatch(from, to),
      },
      {
        $facet: {
          platform: [group(null)],
          owner: [group({ ownerType: '$ownerType', ownerId: '$ownerId' })],
          apiKey: [{ $match: { apiKeyId: { $type: 'string' } } }, group('$apiKeyId')],
          model: [{ $match: { model: { $type: 'string' } } }, group('$model')],
        },
      },
    ]);
    return facets ?? { platform: [], owner: [], apiKey: [], model: [] };
  }

  private async aggregateUsageEvents(from: Date, to: Date) {
    const group = (id: unknown) => ({
      $group: { _id: id, costUsd: { $sum: '$costUsd' }, creditsCharged: { $sum: '$creditsCharged' } },
    });
    const [facets] = await UsageEvent.aggregate<{
      platform: Array<{ costUsd: number; creditsCharged: number }>;
      model: Array<{ _id: string; costUsd: number; creditsCharged: number }>;
    }>([
      { $match: { createdAt: { $gte: from, $lt: to } } },
      { $facet: { platform: [group(null)], model: [{ $match: { model: { $type: 'string' } } }, group('$model')] } },
    ]);
    return facets ?? { platform: [], model: [] };
  }
}

export const SpendRollup =
  (mongoose.models['SpendRollup'] as unknown as ISpendRollupModel) ??
  model<ISpendRollupDocument>('SpendRollup', SpendRollupSchema);
export const spendRollupRepository = new SpendRollupRepository(SpendRollup);
