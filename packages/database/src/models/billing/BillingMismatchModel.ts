import mongoose, { Model, Schema, Types } from 'mongoose';
import { IMongoDocument } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'BillingMismatch';

/** `drift`: row and Stripe disagree. `orphan_stripe`: live in Stripe, no row. `orphan_mongo`: row, gone from Stripe. */
export type BillingMismatchKind = 'drift' | 'orphan_stripe' | 'orphan_mongo';
export type BillingMismatchStatus = 'open' | 'resolved';
export type BillingMismatchResolvedBy = 'reconciliation' | 'sync';

/** Values are display strings (dates as ISO, absent as null) so the shape is the same for every field. */
export interface BillingMismatchField {
  field: string;
  mongo: string | null;
  stripe: string | null;
}

/**
 * Written by apps/workers/src/cron/subscriptionReconciliation.ts, one row per Stripe subscription id,
 * and resolved either by a later run that no longer reproduces it or by Sync from Stripe. A separate
 * collection rather than a flag on Subscription: the webhook worker rewrites that row on every update.
 */
export interface IBillingMismatchDocument extends IMongoDocument {
  stripeSubscriptionId: string;
  kind: BillingMismatchKind;
  /** Null for `orphan_stripe`: there is no row. */
  subscriptionRowId: string | null;
  ownerType: string | null;
  ownerId: string | null;
  fields: BillingMismatchField[];
  stripeStatus: string | null;
  status: BillingMismatchStatus;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  resolvedBy: BillingMismatchResolvedBy | null;
  createdAt: Date;
  updatedAt: Date;
}

export type BillingMismatchFinding = Pick<
  IBillingMismatchDocument,
  'stripeSubscriptionId' | 'kind' | 'subscriptionRowId' | 'ownerType' | 'ownerId' | 'fields' | 'stripeStatus'
>;

type IBillingMismatchModel = Model<IBillingMismatchDocument>;

const BillingMismatchSchema = new Schema<IBillingMismatchDocument>(
  {
    stripeSubscriptionId: { type: String, required: true, unique: true },
    kind: { type: String, required: true, enum: ['drift', 'orphan_stripe', 'orphan_mongo'] },
    subscriptionRowId: { type: Schema.Types.ObjectId, default: null },
    ownerType: { type: String, default: null },
    ownerId: { type: String, default: null },
    fields: {
      type: [
        new Schema(
          {
            field: { type: String, required: true },
            mongo: { type: String, default: null },
            stripe: { type: String, default: null },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    stripeStatus: { type: String, default: null },
    status: { type: String, required: true, enum: ['open', 'resolved'], default: 'open' },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: String, enum: ['reconciliation', 'sync', null], default: null },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

BillingMismatchSchema.index({ status: 1, subscriptionRowId: 1 });

export const BillingMismatchModel: IBillingMismatchModel =
  (mongoose.models[ModelName] as IBillingMismatchModel) ||
  mongoose.model<IBillingMismatchDocument>(ModelName, BillingMismatchSchema);

export class BillingMismatchRepository extends BaseRepository<IBillingMismatchDocument> {
  constructor(private mismatchModel: IBillingMismatchModel) {
    super(mismatchModel);
  }

  /**
   * Records a finding as open. A finding already open keeps its `firstSeenAt`; a resolved one reopens
   * fresh. Returns true when this call opened it (new or reopened), false when it was already open.
   */
  async upsertOpen(finding: BillingMismatchFinding, now: Date): Promise<boolean> {
    const seen = { ...finding, status: 'open' as const, lastSeenAt: now, resolvedAt: null, resolvedBy: null };
    const updated = await this.mismatchModel.updateOne(
      { stripeSubscriptionId: finding.stripeSubscriptionId, status: 'open' },
      { $set: seen }
    );
    if (updated.matchedCount > 0) return false;
    await this.mismatchModel.updateOne(
      { stripeSubscriptionId: finding.stripeSubscriptionId },
      { $set: { ...seen, firstSeenAt: now } },
      { upsert: true }
    );
    return true;
  }

  /**
   * Resolves open findings a run no longer reproduces: those on a `coveredIds` subscription it
   * examined and did not re-flag (`seenIds`). With `completeListing`, an open `orphan_stripe` is also
   * covered: the full listing no longer shows it. Findings the run did not cover are left open.
   */
  async resolveMissing(args: {
    coveredIds: string[];
    seenIds: string[];
    completeListing: boolean;
    now: Date;
  }): Promise<number> {
    const { coveredIds, seenIds, completeListing, now } = args;
    const covered: Record<string, unknown>[] = [{ stripeSubscriptionId: { $in: coveredIds } }];
    if (completeListing) covered.push({ kind: 'orphan_stripe' });
    const result = await this.mismatchModel.updateMany(
      { status: 'open', $or: covered, stripeSubscriptionId: { $nin: seenIds } },
      { $set: { status: 'resolved', resolvedAt: now, resolvedBy: 'reconciliation' } }
    );
    return result.modifiedCount;
  }

  /** Subscription ids of open `drift` and `orphan_mongo` findings, minus `exclude`: the ones a run still has to re-check. */
  async listOpenRowFindingIds(exclude: string[]): Promise<string[]> {
    const found = await this.mismatchModel
      .find({ status: 'open', kind: { $ne: 'orphan_stripe' } }, { stripeSubscriptionId: 1 })
      .lean<Pick<IBillingMismatchDocument, 'stripeSubscriptionId'>[]>();
    // Filtered here, not with $nin: the open set is small, `exclude` is every subscription the run visited.
    const skip = new Set(exclude);
    return found.map(f => f.stripeSubscriptionId).filter(id => !skip.has(id));
  }

  async resolveForSubscription(subscriptionRowId: string, by: BillingMismatchResolvedBy, now = new Date()) {
    await this.mismatchModel.updateMany(
      { subscriptionRowId: new Types.ObjectId(subscriptionRowId), status: 'open' },
      { $set: { status: 'resolved', resolvedAt: now, resolvedBy: by } }
    );
  }

  /** Row ids with an open finding, at most `cap`; `truncated` when there are more. */
  async openSubscriptionRowIds(cap: number): Promise<{ ids: string[]; truncated: boolean }> {
    const rows = await this.mismatchModel
      .find({ status: 'open', subscriptionRowId: { $ne: null } }, { subscriptionRowId: 1 })
      .sort({ _id: 1 })
      .limit(cap + 1)
      .lean<Pick<IBillingMismatchDocument, 'subscriptionRowId'>[]>();
    return { ids: rows.slice(0, cap).map(row => String(row.subscriptionRowId)), truncated: rows.length > cap };
  }

  async openCounts(): Promise<{ open: number; orphanStripe: number; lastSeenAt: Date | null }> {
    const [open, orphanStripe, latest] = await Promise.all([
      this.mismatchModel.countDocuments({ status: 'open' }),
      this.mismatchModel.countDocuments({ status: 'open', kind: 'orphan_stripe' }),
      this.mismatchModel
        .findOne({ status: 'open' }, { lastSeenAt: 1 })
        .sort({ lastSeenAt: -1 })
        .lean<Pick<IBillingMismatchDocument, 'lastSeenAt'>>(),
    ]);
    return { open, orphanStripe, lastSeenAt: latest?.lastSeenAt ?? null };
  }

  async listOpenOrphanStripe(limit: number): Promise<IBillingMismatchDocument[]> {
    return this.mismatchModel
      .find({ status: 'open', kind: 'orphan_stripe' })
      .sort({ firstSeenAt: 1 })
      .limit(limit)
      .lean<IBillingMismatchDocument[]>();
  }

  async findOpenBySubscriptionRowId(subscriptionRowId: string): Promise<IBillingMismatchDocument | null> {
    return this.mismatchModel
      .findOne({ subscriptionRowId: new Types.ObjectId(subscriptionRowId), status: 'open' })
      .lean<IBillingMismatchDocument>();
  }

  async findByStripeSubscriptionId(stripeSubscriptionId: string): Promise<IBillingMismatchDocument | null> {
    return this.mismatchModel.findOne({ stripeSubscriptionId }).lean<IBillingMismatchDocument>();
  }
}

export const billingMismatchRepository = new BillingMismatchRepository(BillingMismatchModel);
