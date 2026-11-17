import { randomUUID } from 'node:crypto';
import mongoose, { Model, model, Schema } from 'mongoose';

/**
 * Transient outbox for the post-deletion confirmation email. The address exists only on the user
 * row, which is gone once the deletion commits, so it is written in that same transaction and
 * removed once a send succeeds (or retries run out). `idHash` is the same keyed hash as the
 * ErasureRecord, which stays hash-only; this collection is why it can.
 */
export type IAccountDeletionNotice = {
  idHash: string;
  email: string;
  attempts: number;
  nextAttemptAt: Date;
  createdAt: Date;
  leaseToken?: string;
  leaseExpiresAt?: Date;
};

export type ClaimedAccountDeletionNotice = IAccountDeletionNotice & { leaseToken: string; leaseExpiresAt: Date };

/** Backstop only: a notice normally ends on send or after the sweep's bounded attempts. */
export const ACCOUNT_DELETION_NOTICE_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Retry delay and claim window; both immediate and sweep sends acquire the same atomic claim. */
export const ACCOUNT_DELETION_NOTICE_RETRY_DELAY_MS = 60 * 60 * 1000;

const AccountDeletionNoticeSchema = new Schema<IAccountDeletionNotice>(
  {
    idHash: { type: String, required: true, unique: true },
    email: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, required: true },
    createdAt: { type: Date, required: true },
    leaseToken: { type: String },
    leaseExpiresAt: { type: Date },
  },
  { versionKey: false }
);

AccountDeletionNoticeSchema.index({ nextAttemptAt: 1 });
AccountDeletionNoticeSchema.index({ createdAt: 1 }, { expireAfterSeconds: ACCOUNT_DELETION_NOTICE_TTL_SECONDS });

export const AccountDeletionNoticeModel: Model<IAccountDeletionNotice> =
  (mongoose.models.AccountDeletionNotice as unknown as Model<IAccountDeletionNotice>) ??
  model<IAccountDeletionNotice>('AccountDeletionNotice', AccountDeletionNoticeSchema);

class AccountDeletionNoticeRepository {
  /**
   * Upsert keyed on `idHash`; a retried delete keeps the first notice. Joins the deletion transaction.
   * Newly committed notices are due immediately; atomic claims arbitrate immediate and sweep sends.
   */
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

  private async claim(
    idHash: string | undefined,
    dueBefore: Date,
    leaseNow: Date,
    excludedIdHashes: readonly string[] = []
  ): Promise<ClaimedAccountDeletionNotice | null> {
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(leaseNow.getTime() + ACCOUNT_DELETION_NOTICE_RETRY_DELAY_MS);
    const notice = await AccountDeletionNoticeModel.findOneAndUpdate(
      {
        ...(idHash !== undefined
          ? { idHash }
          : excludedIdHashes.length
            ? { idHash: { $nin: [...excludedIdHashes] } }
            : {}),
        nextAttemptAt: { $lte: dueBefore },
        $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: leaseNow } }],
      },
      { $set: { leaseToken, leaseExpiresAt } },
      { new: true, sort: { nextAttemptAt: 1 }, projection: { _id: 0 } }
    ).lean<IAccountDeletionNotice>();
    if (!notice) return null;
    return {
      idHash: notice.idHash,
      email: notice.email,
      attempts: notice.attempts,
      nextAttemptAt: notice.nextAttemptAt,
      createdAt: notice.createdAt,
      leaseToken,
      leaseExpiresAt,
    };
  }

  claimDue(idHash: string, dueBefore: Date, leaseNow = new Date()): Promise<ClaimedAccountDeletionNotice | null> {
    return this.claim(idHash, dueBefore, leaseNow);
  }

  claimNextDue(
    dueBefore: Date,
    leaseNow = new Date(),
    excludedIdHashes: readonly string[] = []
  ): Promise<ClaimedAccountDeletionNotice | null> {
    return this.claim(undefined, dueBefore, leaseNow, excludedIdHashes);
  }

  /** Only this claim may record failure; preserve its token through exhaustion cleanup. */
  async markFailed(idHash: string, leaseToken: string, nextAttemptAt: Date): Promise<number | null> {
    const updated = await AccountDeletionNoticeModel.findOneAndUpdate(
      { idHash, leaseToken },
      { $inc: { attempts: 1 }, $set: { nextAttemptAt, leaseExpiresAt: nextAttemptAt } },
      { new: true, projection: { attempts: 1 } }
    ).lean<{ attempts: number }>();
    return updated?.attempts ?? null;
  }

  async remove(idHash: string, leaseToken: string): Promise<void> {
    await AccountDeletionNoticeModel.deleteOne({ idHash, leaseToken });
  }
}

export const accountDeletionNoticeRepository = new AccountDeletionNoticeRepository();
