import mongoose, { Schema } from 'mongoose';
import type { SignupGrantBudgetRepository } from '@bike4mind/common';

type SignupGrantBudgetDay = {
  _id: string;
  spent: number;
  reservedIds: string[];
  alerted50: boolean;
  alerted100: boolean;
};

const budgetDaySchema = new Schema<SignupGrantBudgetDay>(
  {
    _id: { type: String, required: true },
    spent: { type: Number, default: 0, min: 0 },
    reservedIds: { type: [String], default: [] },
    alerted50: { type: Boolean, default: false },
    alerted100: { type: Boolean, default: false },
  },
  { versionKey: false }
);

export const SignupGrantBudgetDayModel =
  (mongoose.models.SignupGrantBudgetDay as mongoose.Model<SignupGrantBudgetDay>) ??
  mongoose.model('SignupGrantBudgetDay', budgetDaySchema);

const isDuplicate = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;

// The counter is a hot row shared by every signup: it must commit on its own rather than join the
// caller's payout transaction (session: null opts out of the ambient one), or concurrent payouts
// would write-conflict on it. Callers refund a reservation whose payout aborts.
const detached = { session: null } as const;

export const signupGrantBudgetRepository: SignupGrantBudgetRepository = {
  async reserve(day, transactionId, amount, budget) {
    if (amount > budget) return null;
    // Two first-of-day callers can both miss the upsert filter and race to insert the day row; the
    // loser gets a duplicate-key error and retries against the row the winner created.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const updated = await SignupGrantBudgetDayModel.findOneAndUpdate(
          { _id: day, spent: { $lte: budget - amount }, reservedIds: { $ne: transactionId } },
          { $inc: { spent: amount }, $addToSet: { reservedIds: transactionId } },
          { upsert: true, new: true, ...detached }
        ).lean();
        return updated ? { spent: updated.spent, fresh: true } : null;
      } catch (error) {
        if (!isDuplicate(error)) throw error;
        const existing = await SignupGrantBudgetDayModel.findById(day, null, detached).lean();
        if (existing?.reservedIds.includes(transactionId)) return { spent: existing.spent, fresh: false };
        if (existing && existing.spent > budget - amount) return null;
      }
    }
    throw new Error('Signup grant budget reservation contended');
  },
  async refund(day, transactionId, amount) {
    await SignupGrantBudgetDayModel.updateOne(
      { _id: day, reservedIds: transactionId },
      { $inc: { spent: -amount }, $pull: { reservedIds: transactionId } }
    ).session(null);
  },
  async markAlerted(day, threshold) {
    const flag = threshold === 50 ? 'alerted50' : 'alerted100';
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
