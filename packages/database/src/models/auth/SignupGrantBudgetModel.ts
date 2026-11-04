import mongoose, { Schema } from 'mongoose';
import type { SignupGrantBudgetRepository } from '@bike4mind/common';

type SignupGrantBudgetDay = {
  _id: string;
  spent: number;
  reservedIds: string[];
  alerted50: boolean;
  alerted100: boolean;
  alertedMissing: boolean;
  createdAt?: Date;
};

const budgetDaySchema = new Schema<SignupGrantBudgetDay>(
  {
    _id: { type: String, required: true },
    spent: { type: Number, default: 0, min: 0 },
    reservedIds: { type: [String], default: [] },
    alerted50: { type: Boolean, default: false },
    alerted100: { type: Boolean, default: false },
    alertedMissing: { type: Boolean, default: false },
  },
  { versionKey: false, timestamps: { createdAt: true, updatedAt: false } }
);

// _id is `<pool>:<YYYY-MM-DD>`. Days are kept 90 days for reporting.
budgetDaySchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const SignupGrantBudgetDayModel =
  (mongoose.models.SignupGrantBudgetDay as mongoose.Model<SignupGrantBudgetDay>) ??
  mongoose.model('SignupGrantBudgetDay', budgetDaySchema);

const isDuplicate = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;

// The counter is a hot row shared by every signup: it must commit on its own rather than join the
// caller's payout transaction (session: null opts out of the ambient one), or concurrent payouts
// would write-conflict on it. Callers refund a reservation whose payout aborts.
const detached = { session: null } as const;

/**
 * Moves today's spend on the pre-pool counter (keyed by the bare day) onto the pool counters, signup pool
 * first, so the day the pools go live cannot pay the retired cap again on top of what it already paid.
 * The `<pool>:<day>` key must match signupGrantBudgetKey (b4m-core/services userService/signupGrantBudget.ts).
 */
export async function carryLegacyGrantBudgetSpend(
  caps: { signup: number; trickle: number },
  now: Date = new Date()
): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  const legacy = await SignupGrantBudgetDayModel.findById(day, { spent: 1 }, detached).lean();
  if (!legacy?.spent) return;
  const signup = Math.min(legacy.spent, caps.signup);
  const shares = { signup, trickle: legacy.spent - signup };
  for (const pool of ['signup', 'trickle'] as const) {
    if (shares[pool] <= 0) continue;
    // $max, not $set: draws the new code already made on the pool counter are kept.
    await SignupGrantBudgetDayModel.updateOne(
      { _id: `${pool}:${day}` },
      { $max: { spent: shares[pool] } },
      { upsert: true }
    );
  }
}

export const signupGrantBudgetRepository: SignupGrantBudgetRepository = {
  async reserve(day, transactionId, amount, budget) {
    // A grant larger than the whole budget could never fit any day, so it may draw only on an untouched day.
    const headroom = Math.max(0, budget - amount);
    // Two first-of-day callers can both miss the upsert filter and race to insert the day row; the
    // loser gets a duplicate-key error and retries against the row the winner created.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const updated = await SignupGrantBudgetDayModel.findOneAndUpdate(
          { _id: day, spent: { $lte: headroom }, reservedIds: { $ne: transactionId } },
          { $inc: { spent: amount }, $addToSet: { reservedIds: transactionId } },
          { upsert: true, new: true, ...detached }
        ).lean();
        return updated ? { spent: updated.spent, fresh: true } : null;
      } catch (error) {
        if (!isDuplicate(error)) throw error;
        const existing = await SignupGrantBudgetDayModel.findById(day, null, detached).lean();
        if (existing?.reservedIds.includes(transactionId)) return { spent: existing.spent, fresh: false };
        if (existing && existing.spent > headroom) return null;
      }
    }
    console.warn('[signup-grant-budget] Reservation contended after retries', { day, transactionId });
    throw new Error('Signup grant budget reservation contended');
  },
  async refund(day, transactionId, amount) {
    await SignupGrantBudgetDayModel.updateOne(
      { _id: day, reservedIds: transactionId },
      { $inc: { spent: -amount }, $pull: { reservedIds: transactionId } }
    ).session(null);
  },
  async getSpent(day) {
    const row = await SignupGrantBudgetDayModel.findById(day, { spent: 1 }, detached).lean();
    return row?.spent ?? 0;
  },
  async markAlerted(day, threshold) {
    const flag = threshold === 50 ? 'alerted50' : threshold === 100 ? 'alerted100' : 'alertedMissing';
    const result = await SignupGrantBudgetDayModel.updateOne(
      { _id: day, [flag]: { $ne: true } },
      { $set: { [flag]: true } },
      { upsert: true }
    )
      .session(null)
      .catch((error: unknown) => {
        if (isDuplicate(error)) return null;
        throw error;
      });
    return !!result && (result.modifiedCount === 1 || result.upsertedCount === 1);
  },
};
