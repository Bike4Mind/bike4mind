import mongoose, { Schema } from 'mongoose';
import { DELEGATION_LIMITS, DELEGATION_STATUSES, type DelegationStatus } from '@bike4mind/common';

/**
 * Something the user forwarded to the assistant with one line of intent (POST /api/v1/delegations).
 * apps/workers/src/events/delegationProcess.ts settles it, and the owner's next brief carries it
 * (apps/workers/src/events/briefCompose.ts): a pending item on every brief until it settles, a settled
 * one exactly once.
 */
export type IDelegatedItem = {
  _id: mongoose.Types.ObjectId;
  userId: string;
  intent: string;
  url: string | null;
  text: string | null;
  fileIds: string[];
  status: DelegationStatus;
  result: string | null;
  failureReason: string | null;
  model: string | null;
  settledAt: Date | null;
  /** Processing lease: while it is in the future, another delivery of the item's event retries later. */
  claimedUntil: Date | null;
  claimToken?: string | null;
  claimWriteVersion?: number;
  /** When a ready brief carried the settled item; null until then. */
  briefedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DelegatedItemInput = Pick<IDelegatedItem, 'userId' | 'intent' | 'url' | 'text' | 'fileIds'>;
export type DelegatedItemOutcome = { status: 'handled' | 'needs_decision'; result: string; model: string };

const schema = new Schema<IDelegatedItem>(
  {
    userId: { type: String, required: true },
    intent: { type: String, required: true, maxlength: DELEGATION_LIMITS.intent },
    url: { type: String, default: null, maxlength: DELEGATION_LIMITS.url },
    text: { type: String, default: null, maxlength: DELEGATION_LIMITS.text },
    fileIds: { type: [String], default: [] },
    status: { type: String, enum: DELEGATION_STATUSES, required: true, default: 'pending' },
    result: { type: String, default: null, maxlength: DELEGATION_LIMITS.result },
    failureReason: { type: String, default: null },
    model: { type: String, default: null },
    settledAt: { type: Date, default: null },
    claimedUntil: { type: Date, default: null },
    claimToken: { type: String, default: null },
    claimWriteVersion: { type: Number, default: 0 },
    briefedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'DelegatedItem' }
);

schema.index({ userId: 1, briefedAt: 1, createdAt: 1 });
schema.index({ userId: 1, status: 1, createdAt: 1 });

export const DelegatedItemModel =
  (mongoose.models.DelegatedItem as mongoose.Model<IDelegatedItem> | undefined) ??
  mongoose.model<IDelegatedItem>('DelegatedItem', schema);

export const delegatedItemRepository = {
  async create(input: DelegatedItemInput): Promise<IDelegatedItem> {
    const created = await DelegatedItemModel.create({ ...input, status: 'pending' });
    return created.toObject();
  },

  async findById(id: string): Promise<IDelegatedItem | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    return DelegatedItemModel.findById(id).lean();
  },

  /** Scoped to the owner: another user's id reads as missing. A malformed id is missing too. */
  async findByIdForUser(id: string, userId: string): Promise<IDelegatedItem | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    return DelegatedItemModel.findOne({ _id: id, userId }).lean();
  },

  /** Each attempt has a stable token; expiry changes on renewal. */
  async claim(id: string, now: Date, leaseMs: number, token: string): Promise<boolean> {
    const result = await DelegatedItemModel.updateOne(
      { _id: id, status: 'pending', $or: [{ claimedUntil: null }, { claimedUntil: { $lte: now } }] },
      { $set: { claimToken: token, claimedUntil: new Date(now.getTime() + leaseMs) } },
      { runValidators: true }
    );
    return result.modifiedCount === 1;
  },

  async renewClaim(id: string, token: string, expectedExpiry: Date, now: Date, leaseMs: number): Promise<Date | null> {
    const expiresAt = new Date(now.getTime() + leaseMs);
    const result = await DelegatedItemModel.updateOne(
      { _id: id, status: 'pending', claimToken: token, claimedUntil: { $eq: expectedExpiry, $gt: now } },
      { $set: { claimedUntil: expiresAt } },
      { runValidators: true }
    );
    return result.matchedCount === 1 ? expiresAt : null;
  },

  async releaseClaim(id: string, leaseEnd: Date, token: string): Promise<void> {
    await DelegatedItemModel.updateOne(
      { _id: id, status: 'pending', claimToken: token, claimedUntil: leaseEnd },
      { $set: { claimedUntil: null, claimToken: null } },
      { runValidators: true }
    );
  },

  /** Stop/drain the attempt first. Its token also covers a renewal whose acknowledgement was lost. */
  async releaseClaimOwned(id: string, token: string): Promise<boolean> {
    const result = await DelegatedItemModel.updateOne(
      { _id: id, status: 'pending', claimToken: token },
      { $set: { claimedUntil: null, claimToken: null } },
      { runValidators: true }
    );
    return result.matchedCount === 1;
  },

  /** A real row write serializes paid admission with takeover in the caller's reservation transaction. */
  async fenceClaim(id: string, token: string, at: Date, session?: mongoose.mongo.ClientSession): Promise<boolean> {
    const result = await DelegatedItemModel.updateOne(
      { _id: id, status: 'pending', claimToken: token, claimedUntil: { $gt: at } },
      { $inc: { claimWriteVersion: 1 } },
      { ...(session ? { session } : {}), runValidators: true }
    );
    return result.matchedCount === 1;
  },

  async markSettledOwned(
    id: string,
    token: string,
    outcome: DelegatedItemOutcome,
    at: Date,
    session?: mongoose.mongo.ClientSession
  ): Promise<boolean> {
    const result = await DelegatedItemModel.updateOne(
      { _id: id, status: 'pending', claimToken: token, claimedUntil: { $gt: at } },
      { $set: { ...outcome, settledAt: at, claimedUntil: null, claimToken: null } },
      { ...(session ? { session } : {}), runValidators: true }
    );
    return result.modifiedCount === 1;
  },

  async markFailedOwned(
    id: string,
    token: string,
    failureReason: string,
    at: Date,
    session?: mongoose.mongo.ClientSession
  ): Promise<boolean> {
    const result = await DelegatedItemModel.updateOne(
      { _id: id, status: 'pending', claimToken: token, claimedUntil: { $gt: at } },
      { $set: { status: 'failed', failureReason, settledAt: at, claimedUntil: null, claimToken: null } },
      { ...(session ? { session } : {}), runValidators: true }
    );
    return result.modifiedCount === 1;
  },

  /** Only a pending item settles, so a redelivered event never overwrites an outcome. */
  async markSettled(id: string, outcome: DelegatedItemOutcome, at: Date): Promise<boolean> {
    const result = await DelegatedItemModel.updateOne(
      { _id: id, status: 'pending' },
      { $set: { ...outcome, settledAt: at } },
      { runValidators: true }
    );
    return result.modifiedCount === 1;
  },

  async markFailed(id: string, failureReason: string, at: Date): Promise<boolean> {
    const result = await DelegatedItemModel.updateOne(
      { _id: id, status: 'pending' },
      { $set: { status: 'failed', failureReason, settledAt: at } },
      { runValidators: true }
    );
    return result.modifiedCount === 1;
  },

  /** Fails the owner's items still pending from before `before`, so a lost event cannot pin one to every brief. */
  async failStale(userId: string, before: Date, at: Date): Promise<number> {
    const result = await DelegatedItemModel.updateMany(
      {
        userId,
        status: 'pending',
        createdAt: { $lt: before },
        $or: [{ claimedUntil: null }, { claimedUntil: { $lte: at } }],
      },
      { $set: { status: 'failed', failureReason: 'timed_out', settledAt: at } },
      { runValidators: true }
    );
    return result.modifiedCount;
  },

  /** Items no ready brief has carried yet, created in `[since, end)` (from any time without `since`), oldest first. */
  async listUnbriefed(userId: string, end: Date, limit: number, since?: Date): Promise<IDelegatedItem[]> {
    return DelegatedItemModel.find({ userId, briefedAt: null, createdAt: { $lt: end, ...(since && { $gte: since }) } })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean();
  },

  /** A still-pending item is never marked: it must reach a later brief with its outcome. */
  async markBriefed(userId: string, ids: string[], at: Date): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await DelegatedItemModel.updateMany(
      { userId, _id: { $in: ids }, status: { $ne: 'pending' }, briefedAt: null },
      { $set: { briefedAt: at } },
      { runValidators: true }
    );
    return result.modifiedCount;
  },
};
