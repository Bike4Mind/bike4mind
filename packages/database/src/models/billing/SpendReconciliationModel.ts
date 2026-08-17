import mongoose, { Model, Schema, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import {
  ISpendReconciliation,
  ISpendReconciliationDocument,
  ISpendReconciliationInput,
  ISpendReconciliationRepository,
  SpendReconciliationInput,
} from '@bike4mind/common';

/**
 * Nightly provider spend reconciliation snapshots. Append-only: newest row
 * per (month, provider) is the current truth; older rows are audit trail.
 */
const SpendReconciliationSchema = new Schema<ISpendReconciliationDocument>(
  {
    month: { type: String, required: true },
    provider: { type: String, required: true },
    providerUsd: { type: Number, required: true },
    internalUsd: { type: Number, required: true },
    deltaUsd: { type: Number, required: true },
    deltaPct: { type: Number, required: true },
    source: { type: String, required: true, enum: ['anthropic_admin_api', 'openai_usage_api', 'manual'] },
    providerBreakdown: { type: Schema.Types.Mixed, required: false },
    note: { type: String, required: false },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

SpendReconciliationSchema.index({ month: 1, provider: 1, createdAt: -1 });

export type ISpendReconciliationModel = Model<ISpendReconciliationDocument>;

export class SpendReconciliationRepository
  extends BaseRepository<ISpendReconciliationDocument>
  implements ISpendReconciliationRepository
{
  constructor(model: ISpendReconciliationModel) {
    super(model);
  }

  async append(row: ISpendReconciliationInput): Promise<ISpendReconciliationDocument> {
    const parsed = SpendReconciliationInput.parse(row);
    const created = await this.create(parsed as ISpendReconciliationDocument);
    if (!created) throw new Error(`SpendReconciliation.append failed for ${parsed.month}/${parsed.provider}`);
    return created;
  }

  async newestPerMonthProvider(): Promise<ISpendReconciliation[]> {
    return this.model.aggregate<ISpendReconciliation>([
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $group: {
          _id: { month: '$month', provider: '$provider' },
          doc: { $first: '$$ROOT' },
        },
      },
      { $replaceRoot: { newRoot: '$doc' } },
      { $sort: { month: -1, provider: 1 } },
    ]);
  }

  async fullHistory(limit = 200): Promise<ISpendReconciliation[]> {
    return this.model
      .find({})
      .sort({ month: -1, provider: 1, createdAt: -1 })
      .limit(limit)
      .lean<ISpendReconciliation[]>();
  }

  async latestByProvider(): Promise<ISpendReconciliation[]> {
    // Newest single row per provider across all months.
    return this.model.aggregate<ISpendReconciliation>([
      { $sort: { month: -1, createdAt: -1, _id: -1 } },
      {
        $group: {
          _id: '$provider',
          doc: { $first: '$$ROOT' },
        },
      },
      { $replaceRoot: { newRoot: '$doc' } },
      { $sort: { provider: 1 } },
    ]);
  }
}

export const SpendReconciliation =
  (mongoose.models['SpendReconciliation'] as unknown as ISpendReconciliationModel) ??
  model<ISpendReconciliationDocument>('SpendReconciliation', SpendReconciliationSchema);
export const spendReconciliationRepository = new SpendReconciliationRepository(SpendReconciliation);
