import mongoose, { Model, Schema, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import {
  COMPLETION_SOURCES,
  CreditHolderType,
  IMongoDocument,
  IModelDayMargin,
  IOwnerSpendDay,
  IOwnerSpendFeature,
  IOwnerSpendMember,
  IOwnerSpendModel,
  IOwnerUsageSummary,
  IPlatformConsumerUsage,
  IPlatformUsageParams,
  IPlatformUsageSummary,
  IProviderMonthCogs,
  ISessionModelUsage,
  ISessionQuestUsage,
  ISessionUsageSummary,
  ISettlementBreakdown,
  ISpendAccountBucket,
  ISpendCostDay,
  ISpendSummary,
  ISpendSummaryFilters,
  IUsageEvent,
  IUsageEventInput,
  IUsageEventRepository,
  IUsageSpendBucket,
  IUsageSpendWithTokens,
  IUserMargin,
  USAGE_EVENT_FEATURES,
  USAGE_EVENT_STATUSES,
} from '@bike4mind/common';

export type IUsageEventDocument = IUsageEvent & IMongoDocument;

// The Spend "by account" table shows top spenders, not every holder; the
// activeAccounts count carries the true distinct total. Bounds the payload when
// spend spans many accounts.
const SPEND_ACCOUNT_LIMIT = 50;

// Same payload guard for the "by model" list: a catalog with many provider/model
// variants would otherwise ship every one. Comfortably above a realistic catalog.
const SPEND_MODEL_LIMIT = 100;

/**
 * One row per provider API call: provider-side quantities and
 * frozen USD cost next to the credits actually debited. Dual-written at
 * settlement via UsageEventRepository.record(); never part of the billing path.
 */
const UsageEventSchema = new Schema<IUsageEventDocument>(
  {
    requestId: { type: String, required: true },
    userId: { type: String, required: true },
    ownerId: { type: String, required: true },
    ownerType: { type: String, required: true, enum: ['User', 'Organization', 'Agent'] as CreditHolderType[] },
    sessionId: { type: String, required: false },
    feature: { type: String, required: true, enum: [...USAGE_EVENT_FEATURES] },
    provider: { type: String, required: true },
    model: { type: String, required: true },

    inputTokens: { type: Number, required: true, default: 0 },
    outputTokens: { type: Number, required: true, default: 0 },
    cachedInputTokens: { type: Number, required: true, default: 0 },
    cacheWriteTokens: { type: Number, required: true, default: 0 },
    providerInputTokens: { type: Number, required: false },
    providerOutputTokens: { type: Number, required: false },
    settledBasis: { type: String, required: false, enum: ['provider', 'local'] },
    units: { type: Number, required: false },

    costUsd: { type: Number, required: true },
    creditsCharged: { type: Number, required: true },
    writtenOffCredits: { type: Number, required: false },

    status: { type: String, required: true, enum: [...USAGE_EVENT_STATUSES], default: 'ok' },
    latencyMs: { type: Number, required: false },

    // Denormalized origin, copied from the same call's ledger write (see
    // UsageEventTypes). Both optional; rows written before this change (or by a
    // recorder whose ledger write carries no source) leave them unset and fall
    // into the UNCLASSIFIED_SOURCE bucket in aggregation.
    source: { type: String, required: false, enum: [...COMPLETION_SOURCES] },
    apiKeyId: { type: String, required: false },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

UsageEventSchema.index({ userId: 1, createdAt: -1 });
UsageEventSchema.index({ provider: 1, model: 1, createdAt: -1 });
UsageEventSchema.index({ createdAt: -1 });
// Supports settlementBreakdown()'s $match on createdAt + settledBasis without an in-memory scan/filter.
UsageEventSchema.index({ createdAt: -1, settledBasis: 1 });
// Supports ownerUsageSummary()'s $match on ownerId + ownerType + createdAt (per-org dashboard).
UsageEventSchema.index({ ownerId: 1, ownerType: 1, createdAt: -1 });
// Supports sessionUsageSummary()'s $match on sessionId (per-session usage detail).
UsageEventSchema.index({ sessionId: 1, createdAt: -1 });
// Supports platformUsageSummary()'s optional source filter over a time window.
UsageEventSchema.index({ source: 1, createdAt: -1 });
// Supports platformUsageSummary()'s byConsumer cut ($match apiKeyId present).
UsageEventSchema.index({ apiKeyId: 1, createdAt: -1 });

export type IUsageEventModel = Model<IUsageEventDocument>;

export class UsageEventRepository extends BaseRepository<IUsageEventDocument> implements IUsageEventRepository {
  constructor(model: IUsageEventModel) {
    super(model);
  }

  async record(event: IUsageEventInput): Promise<IUsageEventDocument | null> {
    return this.create(event as IUsageEventDocument);
  }

  async marginByModelDay(since?: Date): Promise<IModelDayMargin[]> {
    const from = since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return this.model.aggregate<IModelDayMargin>([
      { $match: { createdAt: { $gte: from } } },
      {
        $group: {
          _id: {
            day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
            provider: '$provider',
            model: '$model',
          },
          requests: { $sum: 1 },
          cogsUsd: { $sum: '$costUsd' },
          creditsCharged: { $sum: '$creditsCharged' },
        },
      },
      {
        $project: {
          _id: 0,
          day: '$_id.day',
          provider: '$_id.provider',
          model: '$_id.model',
          requests: 1,
          cogsUsd: 1,
          creditsCharged: 1,
        },
      },
      { $sort: { day: -1, provider: 1, model: 1 } },
    ]);
  }

  async marginByUser(days: number = 30): Promise<IUserMargin[]> {
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return this.model.aggregate<IUserMargin>([
      { $match: { createdAt: { $gte: from } } },
      {
        $group: {
          _id: '$userId',
          requests: { $sum: 1 },
          cogsUsd: { $sum: '$costUsd' },
          creditsCharged: { $sum: '$creditsCharged' },
        },
      },
      {
        $project: {
          _id: 0,
          userId: '$_id',
          requests: 1,
          cogsUsd: 1,
          creditsCharged: 1,
        },
      },
      // Worst margin first: lowest credits-to-cost ratio surfaces negative-margin users.
      {
        $addFields: {
          creditsPerUsd: { $cond: [{ $gt: ['$cogsUsd', 0] }, { $divide: ['$creditsCharged', '$cogsUsd'] }, null] },
        },
      },
      { $sort: { creditsPerUsd: 1 } },
      { $project: { creditsPerUsd: 0 } },
    ]);
  }

  async monthlyCogsByProvider(): Promise<IProviderMonthCogs[]> {
    return this.model.aggregate<IProviderMonthCogs>([
      {
        $group: {
          _id: {
            month: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: 'UTC' } },
            provider: '$provider',
          },
          requests: { $sum: 1 },
          cogsUsd: { $sum: '$costUsd' },
          inputTokens: { $sum: '$inputTokens' },
          outputTokens: { $sum: '$outputTokens' },
          cachedInputTokens: { $sum: '$cachedInputTokens' },
          cacheWriteTokens: { $sum: '$cacheWriteTokens' },
        },
      },
      {
        $project: {
          _id: 0,
          month: '$_id.month',
          provider: '$_id.provider',
          requests: 1,
          cogsUsd: 1,
          inputTokens: 1,
          outputTokens: 1,
          cachedInputTokens: 1,
          cacheWriteTokens: 1,
        },
      },
      { $sort: { month: -1, provider: 1 } },
    ]);
  }

  // Requires MongoDB 7.0+ for the $percentile accumulator (latency facet) and uses
  // $facet like the sibling summaries here - both unsupported under DocumentDB
  // (USE_DOCUMENTDB_COMPATIBILITY), which those methods already assume against.
  async spendSummary(filters: ISpendSummaryFilters = {}): Promise<ISpendSummary> {
    const { from, to, userId, model } = filters;

    const match: Record<string, unknown> = {};
    if (from || to) {
      // Half-open window [from, to): the upper bound is exclusive so adjacent
      // windows (current vs the equal-length prior window, whose `to` is the
      // current window's `from`) don't both count an event at the shared instant.
      const createdAt: Record<string, Date> = {};
      if (from) createdAt.$gte = from;
      if (to) createdAt.$lt = to;
      match.createdAt = createdAt;
    }
    if (userId) match.userId = userId;
    if (model) match.model = model;

    const spendSums = {
      requests: { $sum: 1 },
      cogsUsd: { $sum: '$costUsd' },
      creditsCharged: { $sum: '$creditsCharged' },
    } as const;
    const spendFields = { requests: 1, cogsUsd: 1, creditsCharged: 1 } as const;

    // One $match, fan out with $facet so every cut reconciles against the same
    // event set in a single index scan.
    const [result] = await this.model.aggregate<{
      totals: IUsageSpendBucket[];
      activeAccounts: Array<{ count: number }>;
      latency: Array<{ values: number[] }>;
      status: Array<{ _id: string; count: number }>;
      byModel: IOwnerSpendModel[];
      byAccount: ISpendAccountBucket[];
      dailyCost: ISpendCostDay[];
    }>([
      { $match: match },
      {
        $facet: {
          totals: [{ $group: { _id: null, ...spendSums } }, { $project: { _id: 0, ...spendFields } }],
          activeAccounts: [{ $group: { _id: '$ownerId' } }, { $count: 'count' }],
          latency: [
            { $match: { latencyMs: { $ne: null } } },
            {
              $group: {
                _id: null,
                // $percentile (Mongo 7.0+) keeps this memory-bounded vs pushing every latency into
                // one doc. any: the operator postdates mongoose's typed AccumulatorOperator.
                values: { $percentile: { input: '$latencyMs', p: [0.5, 0.95], method: 'approximate' } } as any,
              },
            },
          ],
          status: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
          byModel: [
            { $group: { _id: { provider: '$provider', model: '$model' }, ...spendSums } },
            { $project: { _id: 0, provider: '$_id.provider', model: '$_id.model', ...spendFields } },
            { $sort: { creditsCharged: -1 } },
            { $limit: SPEND_MODEL_LIMIT },
          ],
          byAccount: [
            { $group: { _id: { ownerId: '$ownerId', ownerType: '$ownerType' }, ...spendSums } },
            { $project: { _id: 0, ownerId: '$_id.ownerId', ownerType: '$_id.ownerType', ...spendFields } },
            { $sort: { creditsCharged: -1 } },
            { $limit: SPEND_ACCOUNT_LIMIT },
          ],
          // Uncapped by design: one row per UTC day in the window feeds the line
          // chart, which needs every point. Bounded by the window length (days),
          // not by event volume, so it stays small even for wide ranges.
          dailyCost: [
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
                cogsUsd: { $sum: '$costUsd' },
              },
            },
            { $project: { _id: 0, day: '$_id', cogsUsd: 1 } },
            { $sort: { day: 1 } },
          ],
        },
      },
    ]);

    const emptyTotals: IUsageSpendBucket = { requests: 0, cogsUsd: 0, creditsCharged: 0 };
    const statusRows = result?.status ?? [];
    const countFor = (s: string) => statusRows.find(r => r._id === s)?.count ?? 0;
    // $percentile emits [p50, p95] in the requested order; empty window => no group => [].
    const latencyValues = result?.latency?.[0]?.values ?? [];

    return {
      totals: result?.totals?.[0] ?? emptyTotals,
      activeAccounts: result?.activeAccounts?.[0]?.count ?? 0,
      latency: { p50: Math.round(latencyValues[0] ?? 0), p95: Math.round(latencyValues[1] ?? 0) },
      status: {
        total: statusRows.reduce((sum, r) => sum + r.count, 0),
        errors: countFor('error'),
        timeouts: countFor('timeout'),
        refusals: countFor('refusal'),
      },
      byModel: result?.byModel ?? [],
      byAccount: result?.byAccount ?? [],
      dailyCost: result?.dailyCost ?? [],
    };
  }

  async settlementBreakdown(days: number = 30): Promise<ISettlementBreakdown[]> {
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    // Both provider counts must be real positive counts to compare against the
    // local estimate. A row settled 'local' can still carry a partial provider
    // report (one axis zero); gating on > 0 keeps those out of the delta.
    const hasProviderCounts = {
      $and: [
        { $gt: [{ $ifNull: ['$providerInputTokens', 0] }, 0] },
        { $gt: [{ $ifNull: ['$providerOutputTokens', 0] }, 0] },
      ],
    };
    return this.model.aggregate<ISettlementBreakdown>([
      { $match: { createdAt: { $gte: from }, settledBasis: { $in: ['provider', 'local'] } } },
      {
        $group: {
          _id: '$settledBasis',
          requests: { $sum: 1 },
          creditsCharged: { $sum: '$creditsCharged' },
          writtenOffCredits: { $sum: { $ifNull: ['$writtenOffCredits', 0] } },
          inputTokenDelta: {
            $sum: { $cond: [hasProviderCounts, { $subtract: ['$providerInputTokens', '$inputTokens'] }, 0] },
          },
          outputTokenDelta: {
            $sum: { $cond: [hasProviderCounts, { $subtract: ['$providerOutputTokens', '$outputTokens'] }, 0] },
          },
          deltaSampleSize: { $sum: { $cond: [hasProviderCounts, 1, 0] } },
        },
      },
      {
        $project: {
          _id: 0,
          settledBasis: '$_id',
          requests: 1,
          creditsCharged: 1,
          writtenOffCredits: 1,
          inputTokenDelta: 1,
          outputTokenDelta: 1,
          deltaSampleSize: 1,
        },
      },
      { $sort: { settledBasis: 1 } },
    ]);
  }

  async ownerUsageSummary(
    ownerId: string,
    ownerType: CreditHolderType,
    days: number = 30
  ): Promise<IOwnerUsageSummary> {
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Every breakdown shares the same three sums, so $group + $project them once.
    const spendSums = {
      requests: { $sum: 1 },
      cogsUsd: { $sum: '$costUsd' },
      creditsCharged: { $sum: '$creditsCharged' },
    } as const;
    const spendFields = { requests: 1, cogsUsd: 1, creditsCharged: 1 } as const;

    // One $match, then fan out with $facet so all cuts reconcile against the
    // same event set in a single index scan.
    const [result] = await this.model.aggregate<{
      overTime: IOwnerSpendDay[];
      byMember: IOwnerSpendMember[];
      byModel: IOwnerSpendModel[];
      byFeature: IOwnerSpendFeature[];
      totals: IUsageSpendBucket[];
    }>([
      { $match: { ownerId, ownerType, createdAt: { $gte: from } } },
      {
        $facet: {
          overTime: [
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
                ...spendSums,
              },
            },
            { $project: { _id: 0, day: '$_id', ...spendFields } },
            { $sort: { day: 1 } },
          ],
          byMember: [
            { $group: { _id: '$userId', ...spendSums } },
            { $project: { _id: 0, userId: '$_id', ...spendFields } },
            { $sort: { creditsCharged: -1 } },
          ],
          byModel: [
            { $group: { _id: { provider: '$provider', model: '$model' }, ...spendSums } },
            { $project: { _id: 0, provider: '$_id.provider', model: '$_id.model', ...spendFields } },
            { $sort: { creditsCharged: -1 } },
          ],
          byFeature: [
            { $group: { _id: '$feature', ...spendSums } },
            { $project: { _id: 0, feature: '$_id', ...spendFields } },
            { $sort: { creditsCharged: -1 } },
          ],
          totals: [{ $group: { _id: null, ...spendSums } }, { $project: { _id: 0, ...spendFields } }],
        },
      },
    ]);

    const emptyTotals: IUsageSpendBucket = { requests: 0, cogsUsd: 0, creditsCharged: 0 };
    return {
      overTime: result?.overTime ?? [],
      byMember: result?.byMember ?? [],
      byModel: result?.byModel ?? [],
      byFeature: result?.byFeature ?? [],
      // $facet yields totals as a 0- or 1-element array; unwrap to a scalar bucket.
      totals: result?.totals?.[0] ?? emptyTotals,
    };
  }

  async platformUsageSummary(params: IPlatformUsageParams = {}): Promise<IPlatformUsageSummary> {
    const { days = 30, source, ownerType } = params;
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Shared across every day/feature/model cut.
    const spendSums = {
      requests: { $sum: 1 },
      cogsUsd: { $sum: '$costUsd' },
      creditsCharged: { $sum: '$creditsCharged' },
    } as const;
    const spendFields = { requests: 1, cogsUsd: 1, creditsCharged: 1 } as const;

    // source and ownerType are optional filters applied the same way - extra
    // $match predicates, never a separate query path. Omitting either spans all.
    const match: Record<string, unknown> = { createdAt: { $gte: from } };
    if (source) match.source = source;
    if (ownerType) match.ownerType = ownerType;

    const [result] = await this.model.aggregate<{
      overTime: IOwnerSpendDay[];
      byFeature: IOwnerSpendFeature[];
      byConsumer: IPlatformConsumerUsage[];
      byModel: IOwnerSpendModel[];
      totals: IUsageSpendBucket[];
    }>([
      { $match: match },
      {
        $facet: {
          overTime: [
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
                ...spendSums,
              },
            },
            { $project: { _id: 0, day: '$_id', ...spendFields } },
            { $sort: { day: 1 } },
          ],
          byFeature: [
            { $group: { _id: '$feature', ...spendSums } },
            { $project: { _id: 0, feature: '$_id', ...spendFields } },
            { $sort: { creditsCharged: -1 } },
          ],
          // Consumers are API-key holders; only key-authed events carry apiKeyId.
          // Tokens ride along so the admin view shows per-consumer input/output.
          byConsumer: [
            { $match: { apiKeyId: { $exists: true, $ne: null } } },
            {
              $group: {
                _id: '$apiKeyId',
                ...spendSums,
                inputTokens: { $sum: '$inputTokens' },
                outputTokens: { $sum: '$outputTokens' },
              },
            },
            { $project: { _id: 0, apiKeyId: '$_id', ...spendFields, inputTokens: 1, outputTokens: 1 } },
            { $sort: { creditsCharged: -1 } },
          ],
          byModel: [
            { $group: { _id: { provider: '$provider', model: '$model' }, ...spendSums } },
            { $project: { _id: 0, provider: '$_id.provider', model: '$_id.model', ...spendFields } },
            { $sort: { creditsCharged: -1 } },
          ],
          totals: [{ $group: { _id: null, ...spendSums } }, { $project: { _id: 0, ...spendFields } }],
        },
      },
    ]);

    const emptyTotals: IUsageSpendBucket = { requests: 0, cogsUsd: 0, creditsCharged: 0 };
    return {
      overTime: result?.overTime ?? [],
      byFeature: result?.byFeature ?? [],
      byConsumer: result?.byConsumer ?? [],
      byModel: result?.byModel ?? [],
      totals: result?.totals?.[0] ?? emptyTotals,
    };
  }

  async sessionUsageSummary(
    sessionId: string,
    owner?: { ownerId: string; ownerType: CreditHolderType }
  ): Promise<ISessionUsageSummary> {
    // Every cut shares the same sums (spend + token quantities), so define once.
    const sums = {
      requests: { $sum: 1 },
      cogsUsd: { $sum: '$costUsd' },
      creditsCharged: { $sum: '$creditsCharged' },
      inputTokens: { $sum: '$inputTokens' },
      outputTokens: { $sum: '$outputTokens' },
      cachedInputTokens: { $sum: '$cachedInputTokens' },
    } as const;
    const fields = {
      requests: 1,
      cogsUsd: 1,
      creditsCharged: 1,
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 1,
    } as const;

    const [result] = await this.model.aggregate<{
      byQuest: ISessionQuestUsage[];
      byModel: ISessionModelUsage[];
      totals: IUsageSpendWithTokens[];
    }>([
      { $match: owner ? { sessionId, ownerId: owner.ownerId, ownerType: owner.ownerType } : { sessionId } },
      {
        $facet: {
          byQuest: [
            { $group: { _id: '$requestId', ...sums } },
            { $project: { _id: 0, requestId: '$_id', ...fields } },
            { $sort: { creditsCharged: -1 } },
          ],
          byModel: [
            { $group: { _id: { provider: '$provider', model: '$model' }, ...sums } },
            { $project: { _id: 0, provider: '$_id.provider', model: '$_id.model', ...fields } },
            { $sort: { creditsCharged: -1 } },
          ],
          totals: [{ $group: { _id: null, ...sums } }, { $project: { _id: 0, ...fields } }],
        },
      },
    ]);

    const emptyTotals: IUsageSpendWithTokens = {
      requests: 0,
      cogsUsd: 0,
      creditsCharged: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    };
    return {
      byQuest: result?.byQuest ?? [],
      byModel: result?.byModel ?? [],
      totals: result?.totals?.[0] ?? emptyTotals,
    };
  }

  async sessionBelongsToOwner(sessionId: string, ownerId: string, ownerType: CreditHolderType): Promise<boolean> {
    // Existence-only probe; the { sessionId, createdAt } index bounds the scan to
    // the session's events (ownerId/ownerType are then matched in memory).
    const doc = await this.model.exists({ sessionId, ownerId, ownerType });
    return doc !== null;
  }
}

export const UsageEvent =
  (mongoose.models['UsageEvent'] as unknown as IUsageEventModel) ??
  model<IUsageEventDocument>('UsageEvent', UsageEventSchema);
export const usageEventRepository = new UsageEventRepository(UsageEvent);
