import mongoose, { Model, Schema, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import {
  CreditHolderType,
  IMongoDocument,
  IModelDayMargin,
  IProviderMonthCogs,
  IUsageEvent,
  IUsageEventInput,
  IUsageEventRepository,
  IUserMargin,
  USAGE_EVENT_FEATURES,
  USAGE_EVENT_STATUSES,
} from '@bike4mind/common';

export type IUsageEventDocument = IUsageEvent & IMongoDocument;

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

    status: { type: String, required: true, enum: [...USAGE_EVENT_STATUSES], default: 'ok' },
    latencyMs: { type: Number, required: false },
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
        },
      },
      { $sort: { month: -1, provider: 1 } },
    ]);
  }
}

export const UsageEvent =
  (mongoose.models['UsageEvent'] as unknown as IUsageEventModel) ??
  model<IUsageEventDocument>('UsageEvent', UsageEventSchema);
export const usageEventRepository = new UsageEventRepository(UsageEvent);
