import mongoose, { Schema } from 'mongoose';
import { PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import { User } from './UserModel';

export type SignupGrantReleaseEntry = {
  userId: string;
  outcome: 'released' | 'not_held' | 'withheld' | 'failed';
  credits: number;
  reversed?: boolean;
};

type SignupGrantReleaseBatch = {
  actorId: string;
  entries: SignupGrantReleaseEntry[];
  createdAt: Date;
};

const batchSchema = new Schema<SignupGrantReleaseBatch>(
  {
    actorId: { type: String, required: true },
    entries: [
      {
        _id: false,
        userId: { type: String, required: true },
        outcome: { type: String, enum: ['released', 'not_held', 'withheld', 'failed'], required: true },
        credits: { type: Number, default: 0, min: 0 },
        reversed: { type: Boolean, default: false },
      },
    ],
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

batchSchema.index({ createdAt: -1 });

export const SignupGrantReleaseBatchModel =
  (mongoose.models.SignupGrantReleaseBatch as mongoose.Model<SignupGrantReleaseBatch>) ??
  mongoose.model('SignupGrantReleaseBatch', batchSchema);

export type HeldSignupGrantReason = 'budget_exhausted';

export type HeldSignupGrantRow = {
  id: string;
  email: string | null;
  reason: HeldSignupGrantReason;
  createdAt: Date;
};

export const signupGrantReleaseRepository = {
  async createBatch(input: { actorId: string; entries: SignupGrantReleaseEntry[] }) {
    const batch = await SignupGrantReleaseBatchModel.create(input);
    return { id: String(batch._id) };
  },
  async findBatch(id: string) {
    if (!mongoose.isValidObjectId(id)) return null;
    const batch = await SignupGrantReleaseBatchModel.findById(id).lean();
    return batch ? { id: String(batch._id), actorId: batch.actorId, entries: batch.entries } : null;
  },
  /** True only for the call that first marks this user's credits from the batch as reversed. */
  async claimReversal(batchId: string, userId: string) {
    const result = await SignupGrantReleaseBatchModel.updateOne(
      { _id: batchId, entries: { $elemMatch: { userId, outcome: 'released', reversed: { $ne: true } } } },
      { $set: { 'entries.$.reversed': true } }
    );
    return result.modifiedCount === 1;
  },
  async unclaimReversal(batchId: string, userId: string) {
    await SignupGrantReleaseBatchModel.updateOne(
      { _id: batchId, entries: { $elemMatch: { userId, outcome: 'released' } } },
      { $set: { 'entries.$.reversed': false } }
    );
  },
  /** Held grants in creation order (ObjectId order); `afterId` is the previous page's last id. */
  async listHeld(input: { reason?: HeldSignupGrantReason; afterId?: string; limit: number; payableOnly?: boolean }) {
    const users = await User.find({
      // $type repeats the user_signupGrantHeldReason partial filter; without it the planner cannot pick that index.
      signupGrantHeldReason: { $eq: input.reason ?? 'budget_exhausted', $type: 'string' },
      tags: PENDING_FREE_CREDITS_TAG,
      // Mirrors accountBlockReasons/isAiAccessRevoked: unpayable accounts must not eat the cron's scan window.
      ...(input.payableOnly
        ? {
            emailVerified: true,
            isBanned: { $ne: true },
            disputePending: { $ne: true },
            isModerated: { $ne: true },
            'moderation.status': { $ne: 'suspended' },
          }
        : {}),
      ...(input.afterId ? { _id: { $gt: input.afterId } } : {}),
    })
      .sort({ _id: 1 })
      .limit(input.limit)
      .select('email signupGrantHeldReason createdAt')
      .lean();
    return users.map((user): HeldSignupGrantRow => ({
      id: String(user._id),
      email: user.email ?? null,
      reason: user.signupGrantHeldReason as HeldSignupGrantReason,
      createdAt: user.createdAt,
    }));
  },
  /** Payable accounts whose held payment unlock has settled, in ObjectId order; `afterId` pages. */
  async listDueHeldUnlocks(input: { now: Date; afterId?: string; limit: number }) {
    const users = await User.find({
      // $type repeats the user_signupGrant_heldUnlock_releaseAt partial filter so the planner can pick that index.
      'signupGrant.heldUnlock.releaseAt': { $lte: input.now, $type: 'date' },
      emailVerified: true,
      isBanned: { $ne: true },
      disputePending: { $ne: true },
      isModerated: { $ne: true },
      'moderation.status': { $ne: 'suspended' },
      ...(input.afterId ? { _id: { $gt: input.afterId } } : {}),
    })
      .sort({ _id: 1 })
      .limit(input.limit)
      .select('_id')
      .lean();
    return users.map(user => String(user._id));
  },
};
