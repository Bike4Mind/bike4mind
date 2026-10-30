import mongoose, { Model, Schema } from 'mongoose';
import { IMongoDocument } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'RevenueSnapshot';

/** Minor units. Other-currency and unpriced rows are counted, not summed (docs/admin-subscriptions-spec.md 5.3). */
export type RevenueSnapshotMrr = { amount: number; unpriced: number; otherCurrency: number };

export type RevenueSnapshotBreakdown<Key extends string> = Record<Key, string | null> & {
  /** Rows behind this entry, priced or not. */
  count: number;
} & RevenueSnapshotMrr;

/**
 * Written by apps/workers/src/cron/revenueSnapshot.ts. Totals are as of the run, just after the day ended;
 * `newMrr` and `churnedMrr` cover the day itself. `newMrr` counts rows created that day that already count
 * toward MRR at the run, so a row that starts incomplete and pays on a later day is in no day's `newMrr`.
 */
export interface IRevenueSnapshotDocument extends IMongoDocument {
  /** UTC day, `YYYY-MM-DD`; unique, so a rerun overwrites that day's row. */
  snapshotDate: string;
  computedAt: Date;
  /** Lowercase Stripe code; every amount here is in it. */
  currency: string;
  mrr: RevenueSnapshotMrr;
  payingCount: number;
  mrrByPlan: RevenueSnapshotBreakdown<'priceId'>[];
  mrrByOwnerType: RevenueSnapshotBreakdown<'ownerType'>[];
  newMrr: RevenueSnapshotMrr;
  churnedMrr: RevenueSnapshotMrr;
  pastDueMrr: RevenueSnapshotMrr;
  cancelingMrr: RevenueSnapshotMrr;
  createdAt: Date;
  updatedAt: Date;
}

export type RevenueSnapshotInput = Omit<IRevenueSnapshotDocument, 'id' | 'createdAt' | 'updatedAt'>;

type IRevenueSnapshotModel = Model<IRevenueSnapshotDocument>;

const mrrFields = {
  amount: { type: Number, required: true },
  unpriced: { type: Number, required: true },
  otherCurrency: { type: Number, required: true },
};

const MrrSchema = new Schema(mrrFields, { _id: false });

const breakdownSchema = (key: string) =>
  new Schema(
    { [key]: { type: String, default: null }, count: { type: Number, required: true }, ...mrrFields },
    { _id: false }
  );

const RevenueSnapshotSchema = new Schema<IRevenueSnapshotDocument>(
  {
    snapshotDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    computedAt: { type: Date, required: true },
    currency: { type: String, required: true },
    mrr: { type: MrrSchema, required: true },
    payingCount: { type: Number, required: true },
    mrrByPlan: { type: [breakdownSchema('priceId')], default: [] },
    mrrByOwnerType: { type: [breakdownSchema('ownerType')], default: [] },
    newMrr: { type: MrrSchema, required: true },
    churnedMrr: { type: MrrSchema, required: true },
    pastDueMrr: { type: MrrSchema, required: true },
    cancelingMrr: { type: MrrSchema, required: true },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

// No TTL: one small row a day is the history.
RevenueSnapshotSchema.index({ snapshotDate: 1 }, { unique: true });

export const RevenueSnapshotModel: IRevenueSnapshotModel =
  (mongoose.models[ModelName] as IRevenueSnapshotModel) ||
  mongoose.model<IRevenueSnapshotDocument>(ModelName, RevenueSnapshotSchema);

export class RevenueSnapshotRepository extends BaseRepository<IRevenueSnapshotDocument> {
  constructor(private snapshotModel: IRevenueSnapshotModel) {
    super(snapshotModel);
  }

  async upsertSnapshot(input: RevenueSnapshotInput): Promise<void> {
    await this.snapshotModel.findOneAndUpdate(
      { snapshotDate: input.snapshotDate },
      { $set: input },
      { upsert: true, setDefaultsOnInsert: true, runValidators: true }
    );
  }

  /** `from` and `to` are inclusive `YYYY-MM-DD` days; oldest first. */
  async findRange(from: string, to: string): Promise<IRevenueSnapshotDocument[]> {
    return this.snapshotModel
      .find({ snapshotDate: { $gte: from, $lte: to } })
      .sort({ snapshotDate: 1 })
      .lean<IRevenueSnapshotDocument[]>();
  }

  async firstSnapshotDate(): Promise<string | null> {
    const first = await this.snapshotModel
      .findOne({}, { snapshotDate: 1 })
      .sort({ snapshotDate: 1 })
      .lean<Pick<IRevenueSnapshotDocument, 'snapshotDate'>>();
    return first?.snapshotDate ?? null;
  }
}

export const revenueSnapshotRepository = new RevenueSnapshotRepository(RevenueSnapshotModel);
