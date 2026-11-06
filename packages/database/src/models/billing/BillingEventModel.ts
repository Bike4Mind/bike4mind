import mongoose, { Model, Schema, Types } from 'mongoose';
import type { AuditLogCursor, BillingEventData, BillingEventOwnerType, IMongoDocument } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'BillingEvent';

/**
 * One Stripe webhook event this stage owns, written by pages/api/stripe/webhook.ts after the event's side
 * effects succeed (docs/admin-subscriptions-spec.md 6.2). Feeds the subscription Timeline tab and is the
 * dispute record, so there is no TTL.
 */
export interface IBillingEventDocument extends IMongoDocument {
  stripeEventId: string;
  type: string;
  ownerType: BillingEventOwnerType | null;
  ownerId: string | null;
  /** The Stripe subscription id (`sub_...`), as Subscription.subscriptionId stores it. */
  subscriptionId: string | null;
  /** Minor units. */
  amount: number | null;
  /** Lowercase Stripe code. */
  currency: string | null;
  /** Stripe's `event.created`. */
  occurredAt: Date;
  data: BillingEventData;
  createdAt: Date;
  updatedAt: Date;
}

export type BillingEventInput = Omit<IBillingEventDocument, 'id' | 'createdAt' | 'updatedAt'>;

type IBillingEventModel = Model<IBillingEventDocument>;

const BillingEventSchema = new Schema<IBillingEventDocument>(
  {
    stripeEventId: { type: String, required: true, unique: true },
    type: { type: String, required: true },
    ownerType: { type: String, enum: ['user', 'organization', null], default: null },
    ownerId: { type: String, default: null },
    subscriptionId: { type: String, default: null },
    amount: { type: Number, default: null },
    currency: { type: String, default: null },
    occurredAt: { type: Date, required: true },
    data: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, minimize: false, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

BillingEventSchema.index({ subscriptionId: 1, occurredAt: -1 });
BillingEventSchema.index({ ownerType: 1, ownerId: 1, occurredAt: -1 });

export const BillingEventModel: IBillingEventModel =
  (mongoose.models[ModelName] as IBillingEventModel) ||
  mongoose.model<IBillingEventDocument>(ModelName, BillingEventSchema);

type BillingEventRow = BillingEventInput & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

export type BillingEventRecord = BillingEventInput & { id: string };

const toRecord = ({
  _id,
  createdAt: _createdAt,
  updatedAt: _updatedAt,
  ...row
}: BillingEventRow): BillingEventRecord => ({
  ...row,
  id: _id.toString(),
});

export class BillingEventRepository extends BaseRepository<IBillingEventDocument> {
  constructor(private billingEventModel: IBillingEventModel) {
    super(billingEventModel);
  }

  /**
   * Upserts on `stripeEventId`; the first write wins, so a redelivery of an already recorded event changes
   * nothing. Returns whether this call inserted the row.
   */
  async record(input: BillingEventInput): Promise<boolean> {
    const result = await this.billingEventModel.updateOne(
      { stripeEventId: input.stripeEventId },
      { $setOnInsert: input },
      { upsert: true }
    );
    return result.upsertedCount > 0;
  }

  /**
   * One subscription's events, plus its owner's events that name no subscription (refunds, disputes) when
   * `ownerLevelTypes` is given. Newest first on (occurredAt, _id), strictly after `cursor`.
   */
  async listForSubscription(
    scope: {
      subscriptionId: string;
      owner?: { ownerType: BillingEventOwnerType; ownerId: string };
      ownerLevelTypes?: readonly string[];
    },
    page: { limit: number; cursor?: AuditLogCursor }
  ): Promise<{ records: BillingEventRecord[]; hasMore: boolean }> {
    const { subscriptionId, owner, ownerLevelTypes } = scope;
    const sources: Record<string, unknown>[] = [{ subscriptionId }];
    if (owner && ownerLevelTypes?.length) {
      sources.push({
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        subscriptionId: null,
        type: { $in: [...ownerLevelTypes] },
      });
    }
    const clauses: Record<string, unknown>[] = [sources.length > 1 ? { $or: sources } : sources[0]];
    if (page.cursor) {
      clauses.push({
        $or: [
          { occurredAt: { $lt: page.cursor.occurredAt } },
          { occurredAt: page.cursor.occurredAt, _id: { $lt: new Types.ObjectId(page.cursor.id) } },
        ],
      });
    }
    const rows = await this.billingEventModel
      .find({ $and: clauses })
      .sort({ occurredAt: -1, _id: -1 })
      .limit(page.limit + 1)
      .lean<BillingEventRow[]>();
    return { records: rows.slice(0, page.limit).map(toRecord), hasMore: rows.length > page.limit };
  }
}

export const billingEventRepository = new BillingEventRepository(BillingEventModel);
