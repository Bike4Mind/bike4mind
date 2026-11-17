import mongoose, { Model, model, Schema } from 'mongoose';

/**
 * Transient outbox for the post-deletion confirmation email. The address exists only on the user
 * row, which is gone once the deletion commits, so it is written in that same transaction and
 * removed once a send succeeds (or retries run out). `idHash` is the same keyed hash as the
 * ErasureRecord, which stays hash-only; this collection is why it can.
 */
export interface IAccountDeletionNotice {
  idHash: string;
  email: string;
  attempts: number;
  nextAttemptAt: Date;
  createdAt: Date;
}

/** Backstop only: a notice normally ends on send or after the sweep's bounded attempts. */
export const ACCOUNT_DELETION_NOTICE_TTL_SECONDS = 30 * 24 * 60 * 60;

const AccountDeletionNoticeSchema = new Schema<IAccountDeletionNotice>(
  {
    idHash: { type: String, required: true, unique: true },
    email: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, required: true },
    createdAt: { type: Date, required: true },
  },
  { versionKey: false }
);

AccountDeletionNoticeSchema.index({ nextAttemptAt: 1 });
AccountDeletionNoticeSchema.index({ createdAt: 1 }, { expireAfterSeconds: ACCOUNT_DELETION_NOTICE_TTL_SECONDS });

export const AccountDeletionNoticeModel: Model<IAccountDeletionNotice> =
  (mongoose.models.AccountDeletionNotice as unknown as Model<IAccountDeletionNotice>) ??
  model<IAccountDeletionNotice>('AccountDeletionNotice', AccountDeletionNoticeSchema);

class AccountDeletionNoticeRepository {
  /** Upsert keyed on `idHash`; a retried delete keeps the first notice. Joins an open transaction. */
  async record(input: { idHash: string; email: string; now: Date }): Promise<void> {
    await AccountDeletionNoticeModel.updateOne(
      { idHash: input.idHash },
      {
        $setOnInsert: {
          idHash: input.idHash,
          email: input.email,
          attempts: 0,
          nextAttemptAt: input.now,
          createdAt: input.now,
        },
      },
      { upsert: true }
    );
  }

  async find(idHash: string): Promise<IAccountDeletionNotice | null> {
    return AccountDeletionNoticeModel.findOne({ idHash }, { _id: 0 }).lean<IAccountDeletionNotice>();
  }

  /** Notices whose next attempt is due, oldest first. */
  async listDue(now: Date, limit: number): Promise<IAccountDeletionNotice[]> {
    return AccountDeletionNoticeModel.find({ nextAttemptAt: { $lte: now } }, { _id: 0 })
      .sort({ nextAttemptAt: 1 })
      .limit(limit)
      .lean<IAccountDeletionNotice[]>();
  }

  /** Counts a failed send and returns the new attempt count, or null when the notice is gone. */
  async markFailed(idHash: string, nextAttemptAt: Date): Promise<number | null> {
    const updated = await AccountDeletionNoticeModel.findOneAndUpdate(
      { idHash },
      { $inc: { attempts: 1 }, $set: { nextAttemptAt } },
      { new: true, projection: { attempts: 1 } }
    ).lean<{ attempts: number }>();
    return updated?.attempts ?? null;
  }

  async remove(idHash: string): Promise<void> {
    await AccountDeletionNoticeModel.deleteOne({ idHash });
  }
}

export const accountDeletionNoticeRepository = new AccountDeletionNoticeRepository();
