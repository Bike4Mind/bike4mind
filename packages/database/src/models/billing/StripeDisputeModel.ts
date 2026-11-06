import mongoose, { Document, Model, model, Schema, Types } from 'mongoose';
import {
  STRIPE_DISPUTE_ADMIN_RESOLVABLE,
  STRIPE_DISPUTE_OUTCOMES,
  STRIPE_DISPUTE_STATES,
  STRIPE_DISPUTE_SUBJECTS,
  type StripeDisputeContain,
  type StripeDisputeItem,
  type StripeDisputeResolution,
  type StripeDisputeState,
  type StripeDisputeSubject,
} from '@bike4mind/common';

/**
 * One Stripe dispute, keyed by its Stripe id (contract in b4m-core/common/src/schemas/stripeDispute.ts).
 * The webhook upserts it on every dispute event, so a redelivery or an out-of-order close never
 * duplicates it. `contain.snapshot` is what the automatic Contain changed, opaque here and read by
 * its undo (apps/client/server/billing/stripeDisputes.ts).
 */
export interface IStripeDisputeDocument extends Document {
  stripeDisputeId: string;
  chargeId: string | null;
  paymentIntentId: string | null;
  amount: number;
  currency: string;
  reason: string;
  stripeStatus: string;
  subject: StripeDisputeSubject;
  subjectId: string | null;
  state: StripeDisputeState;
  openedAt: Date;
  closedAt: Date | null;
  resolution: StripeDisputeResolution | null;
  contain: (StripeDisputeContain & { snapshot: unknown }) | null;
  createdAt: Date;
  updatedAt: Date;
}

const ResolutionSchema = new Schema<StripeDisputeResolution>(
  {
    outcome: { type: String, enum: STRIPE_DISPUTE_OUTCOMES, required: true },
    resolvedBy: { type: String, default: null },
    note: { type: String, default: null },
    resolvedAt: { type: Date, required: true },
  },
  { _id: false }
);

const ContainSchema = new Schema<StripeDisputeContain & { snapshot: unknown }>(
  {
    batchId: { type: String, required: true },
    containedAt: { type: Date, required: true },
    suspended: { type: Boolean, required: true },
    creditDelta: { type: Number, required: true },
    apiKeysRevoked: { type: Number, required: true },
    undoneAt: { type: Date, default: null },
    undoneBy: { type: String, default: null },
    snapshot: { type: Schema.Types.Mixed, required: true },
  },
  { _id: false, minimize: false }
);

export const StripeDisputeSchema = new Schema<IStripeDisputeDocument>(
  {
    stripeDisputeId: { type: String, required: true, unique: true },
    chargeId: { type: String, default: null },
    paymentIntentId: { type: String, default: null },
    amount: { type: Number, required: true },
    currency: { type: String, required: true },
    reason: { type: String, required: true },
    stripeStatus: { type: String, required: true },
    subject: { type: String, enum: STRIPE_DISPUTE_SUBJECTS, required: true },
    subjectId: { type: String, default: null },
    state: { type: String, enum: STRIPE_DISPUTE_STATES, default: 'open' },
    openedAt: { type: Date, required: true },
    closedAt: { type: Date, default: null },
    resolution: { type: ResolutionSchema, default: null },
    contain: { type: ContainSchema, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'StripeDispute' }
);

StripeDisputeSchema.index({ state: 1, subject: 1, openedAt: -1 });

export const StripeDisputeModel: Model<IStripeDisputeDocument> =
  (mongoose.models.StripeDispute as unknown as Model<IStripeDisputeDocument>) ??
  model<IStripeDisputeDocument>('StripeDispute', StripeDisputeSchema);

/** The dispute as Stripe describes it, plus whose payment it was. */
export type StripeDisputeFacts = Pick<
  StripeDisputeItem,
  | 'stripeDisputeId'
  | 'chargeId'
  | 'paymentIntentId'
  | 'amount'
  | 'currency'
  | 'reason'
  | 'stripeStatus'
  | 'subject'
  | 'subjectId'
  | 'openedAt'
>;

export type StripeDisputeContainInput = Omit<StripeDisputeContain, 'undoneAt' | 'undoneBy'> & { snapshot: unknown };

export type AdminStripeDisputeUpdateResult =
  | { status: 'updated'; item: StripeDisputeItem }
  | { status: 'conflict'; item: StripeDisputeItem }
  | { status: 'not_found' };

type LeanStripeDispute = Omit<IStripeDisputeDocument, keyof Document> & { _id: Types.ObjectId };

const toItem = (doc: LeanStripeDispute): StripeDisputeItem => ({
  id: doc._id.toString(),
  stripeDisputeId: doc.stripeDisputeId,
  chargeId: doc.chargeId ?? null,
  paymentIntentId: doc.paymentIntentId ?? null,
  amount: doc.amount,
  currency: doc.currency,
  reason: doc.reason,
  stripeStatus: doc.stripeStatus,
  subject: doc.subject,
  subjectId: doc.subjectId ?? null,
  state: doc.state,
  openedAt: doc.openedAt,
  closedAt: doc.closedAt ?? null,
  resolution: doc.resolution
    ? {
        outcome: doc.resolution.outcome,
        resolvedBy: doc.resolution.resolvedBy ?? null,
        note: doc.resolution.note ?? null,
        resolvedAt: doc.resolution.resolvedAt,
      }
    : null,
  contain: doc.contain
    ? {
        batchId: doc.contain.batchId,
        containedAt: doc.contain.containedAt,
        suspended: doc.contain.suspended,
        creditDelta: doc.contain.creditDelta,
        apiKeysRevoked: doc.contain.apiKeysRevoked,
        undoneAt: doc.contain.undoneAt ?? null,
        undoneBy: doc.contain.undoneBy ?? null,
      }
    : null,
});

/** The facts a later event may not change: whose dispute it is and what was disputed. */
const insertOnly = ({ stripeStatus: _stripeStatus, ...facts }: StripeDisputeFacts) => facts;

class StripeDisputeRepository {
  /** Records a new dispute; a redelivery leaves the existing record as it is. */
  async recordOpened(facts: StripeDisputeFacts): Promise<StripeDisputeItem> {
    const doc = await StripeDisputeModel.findOneAndUpdate(
      { stripeDisputeId: facts.stripeDisputeId },
      { $setOnInsert: { ...insertOnly(facts), stripeStatus: facts.stripeStatus } },
      { upsert: true, new: true }
    ).lean<LeanStripeDispute>();
    return toItem(doc as LeanStripeDispute);
  }

  /**
   * Stores Stripe's final status. Creates the record when the dispute predates this collection or its
   * open event was lost, so a close is never dropped. `redelivered` is true when the record already held
   * this close, so a caller can skip notifying twice.
   */
  async recordClosed(facts: StripeDisputeFacts, closedAt: Date): Promise<StripeDisputeItem & { redelivered: boolean }> {
    const before = await StripeDisputeModel.findOneAndUpdate(
      { stripeDisputeId: facts.stripeDisputeId },
      { $setOnInsert: insertOnly(facts), $set: { stripeStatus: facts.stripeStatus, closedAt } },
      { upsert: true, new: false }
    ).lean<LeanStripeDispute>();
    // A close that found the user upgrades a still-open org/unmatched row, so the lost handler contains
    // the account the close names. Anything else keeps the subject the record was created with.
    if (facts.subject === 'user' && before && before.subject !== 'user' && before.state === 'open') {
      await StripeDisputeModel.updateOne(
        { stripeDisputeId: facts.stripeDisputeId, state: 'open' },
        { $set: { subject: facts.subject, subjectId: facts.subjectId } }
      );
    }
    const doc = await StripeDisputeModel.findOne({ stripeDisputeId: facts.stripeDisputeId }).lean<LeanStripeDispute>();
    const redelivered = before?.closedAt != null && before.stripeStatus === facts.stripeStatus;
    return { ...toItem(doc as LeanStripeDispute), redelivered };
  }

  /**
   * Re-files an open user dispute whose user no longer exists as unmatched, so an admin can resolve it:
   * the system has no account left to contain. No-op for any other record.
   */
  async markUserGone(stripeDisputeId: string): Promise<StripeDisputeItem | null> {
    const doc = await StripeDisputeModel.findOneAndUpdate(
      { stripeDisputeId, subject: 'user', state: 'open' },
      { $set: { subject: 'unmatched', subjectId: null } },
      { new: true }
    ).lean<LeanStripeDispute>();
    return doc ? toItem(doc) : null;
  }

  async findById(id: string): Promise<(StripeDisputeItem & { containSnapshot: unknown }) | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await StripeDisputeModel.findById(id).lean<LeanStripeDispute>();
    return doc ? { ...toItem(doc), containSnapshot: doc.contain?.snapshot ?? null } : null;
  }

  /**
   * Resolves an open dispute from its Stripe outcome, attaching the Contain it applied, in one
   * conditional write. Null when it was already resolved, which is what makes a redelivered close a
   * no-op. Runs inside the Contain's transaction when there is one.
   */
  async resolveBySystem(
    stripeDisputeId: string,
    outcome: 'won' | 'lost',
    contain: StripeDisputeContainInput | null = null
  ): Promise<StripeDisputeItem | null> {
    const resolution: StripeDisputeResolution = { outcome, resolvedBy: null, note: null, resolvedAt: new Date() };
    const containDoc = contain ? { ...contain, undoneAt: null, undoneBy: null } : null;
    const doc = await StripeDisputeModel.findOneAndUpdate(
      { stripeDisputeId, state: 'open' },
      { $set: { state: 'resolved', resolution, ...(containDoc ? { contain: containDoc } : {}) } },
      { new: true }
    ).lean<LeanStripeDispute>();
    return doc ? toItem(doc) : null;
  }

  /** An admin closes a dispute isStripeDisputeAdminResolvable allows (the same rule, as one conditional write); anything else is a conflict. */
  async resolveByAdmin(input: { id: string; adminId: string; note: string }): Promise<AdminStripeDisputeUpdateResult> {
    if (!Types.ObjectId.isValid(input.id)) return { status: 'not_found' };
    const resolution: StripeDisputeResolution = {
      outcome: 'admin',
      resolvedBy: input.adminId,
      note: input.note,
      resolvedAt: new Date(),
    };
    const updated = await StripeDisputeModel.findOneAndUpdate(
      {
        _id: input.id,
        state: 'open',
        $or: [
          { subject: { $in: STRIPE_DISPUTE_ADMIN_RESOLVABLE } },
          { closedAt: { $ne: null }, stripeStatus: { $nin: ['won', 'lost'] } },
        ],
      },
      { $set: { state: 'resolved', resolution } },
      { new: true }
    ).lean<LeanStripeDispute>();
    return this.updateResult(input.id, updated);
  }

  /** Marks the Contain undone once; a second undo is a conflict. Runs inside the undo's transaction. */
  async markContainUndone(input: { id: string; adminId: string }): Promise<AdminStripeDisputeUpdateResult> {
    if (!Types.ObjectId.isValid(input.id)) return { status: 'not_found' };
    const updated = await StripeDisputeModel.findOneAndUpdate(
      { _id: input.id, contain: { $ne: null }, 'contain.undoneAt': null },
      { $set: { 'contain.undoneAt': new Date(), 'contain.undoneBy': input.adminId } },
      { new: true }
    ).lean<LeanStripeDispute>();
    return this.updateResult(input.id, updated);
  }

  /**
   * Adds the Stripe subscriptions the automatic Contain canceled to its undo snapshot. They are canceled
   * after the Contain commits, so they cannot be part of the snapshot resolveBySystem writes; an undo
   * reads them to report what it cannot restore. No-op once the Contain was undone.
   */
  async recordContainCanceledSubscriptions(stripeDisputeId: string, subscriptionIds: string[]): Promise<void> {
    await StripeDisputeModel.updateOne(
      { stripeDisputeId, contain: { $ne: null }, 'contain.undoneAt': null },
      { $set: { 'contain.snapshot.canceledSubscriptions': subscriptionIds } }
    );
  }

  /** Newest first; `truncated` is true when more than `limit` records match. */
  async list(query: {
    state?: StripeDisputeState;
    subject?: StripeDisputeSubject;
    limit: number;
  }): Promise<{ data: StripeDisputeItem[]; truncated: boolean }> {
    const filter: Record<string, unknown> = {};
    if (query.state) filter.state = query.state;
    if (query.subject) filter.subject = query.subject;
    const docs = await StripeDisputeModel.find(filter)
      .sort({ openedAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .lean<LeanStripeDispute[]>();
    return { data: docs.slice(0, query.limit).map(toItem), truncated: docs.length > query.limit };
  }

  private async updateResult(id: string, updated: LeanStripeDispute | null): Promise<AdminStripeDisputeUpdateResult> {
    if (updated) return { status: 'updated', item: toItem(updated) };
    const current = await StripeDisputeModel.findById(id).lean<LeanStripeDispute>();
    return current ? { status: 'conflict', item: toItem(current) } : { status: 'not_found' };
  }
}

export const stripeDisputeRepository = new StripeDisputeRepository();
