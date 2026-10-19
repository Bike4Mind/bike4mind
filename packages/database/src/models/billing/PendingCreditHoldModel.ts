import mongoose, { Model, Schema, model } from 'mongoose';
import { CreditHolderType, type CreditHoldRecord } from '@bike4mind/common';

/**
 * One outstanding request credit hold: the balance already moved at reserve time, and the row lives until
 * exactly one of settle, refund or the expired-hold sweep claims it. Claiming deletes the row, so whichever
 * caller deletes it is the only one allowed to move credits back (see apps/client/server/billing/
 * reserveRequestCredits.ts and apps/workers/src/cron/creditHoldSweep.ts).
 *
 * expiresAt is deliberately NOT a TTL index: Mongo would drop the row without returning the credits.
 */
export type PendingCreditHold = CreditHoldRecord & {
  id: string;
  featureLabel: string;
  expiresAt: Date;
};

type PendingCreditHoldDocument = Omit<PendingCreditHold, 'id'> & { _id: mongoose.Types.ObjectId };

const PendingCreditHoldSchema = new Schema<PendingCreditHoldDocument>(
  {
    ownerId: { type: String, required: true },
    ownerType: {
      type: String,
      required: true,
      enum: [CreditHolderType.User, CreditHolderType.Organization],
    },
    userId: { type: String, required: true },
    organizationId: { type: String, default: null },
    reservedCredits: { type: Number, required: true },
    balanceAfterHold: { type: Number, required: true },
    featureLabel: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

PendingCreditHoldSchema.index({ expiresAt: 1 });

type PendingCreditHoldModel = Model<PendingCreditHoldDocument>;

const toPendingCreditHold = (doc: PendingCreditHoldDocument): PendingCreditHold => ({
  id: doc._id.toString(),
  ownerId: doc.ownerId,
  ownerType: doc.ownerType,
  userId: doc.userId,
  organizationId: doc.organizationId ?? null,
  reservedCredits: doc.reservedCredits,
  balanceAfterHold: doc.balanceAfterHold,
  featureLabel: doc.featureLabel,
  expiresAt: doc.expiresAt,
});

export class PendingCreditHoldRepository {
  constructor(private readonly model: PendingCreditHoldModel) {}

  async record(hold: CreditHoldRecord, featureLabel: string, expiresAt: Date): Promise<PendingCreditHold> {
    const doc = await this.model.create({ ...hold, featureLabel, expiresAt });
    return toPendingCreditHold(doc.toObject());
  }

  /** Atomically takes ownership of the hold; null means another caller already claimed it. */
  async claim(id: string): Promise<PendingCreditHold | null> {
    const doc = await this.model.findOneAndDelete({ _id: id }).lean<PendingCreditHoldDocument>();
    return doc ? toPendingCreditHold(doc) : null;
  }

  /** Like claim, but only while the hold is still expired at `now`. */
  async claimExpired(id: string, now: Date): Promise<PendingCreditHold | null> {
    const doc = await this.model
      .findOneAndDelete({ _id: id, expiresAt: { $lte: now } })
      .lean<PendingCreditHoldDocument>();
    return doc ? toPendingCreditHold(doc) : null;
  }

  /** Oldest first, so a backlog drains in expiry order over successive sweeps. */
  async findExpired(now: Date, limit: number): Promise<PendingCreditHold[]> {
    const docs = await this.model
      .find({ expiresAt: { $lte: now } })
      .sort({ expiresAt: 1 })
      .limit(limit)
      .lean<PendingCreditHoldDocument[]>();
    return docs.map(toPendingCreditHold);
  }
}

export const PendingCreditHoldModel =
  (mongoose.models['PendingCreditHold'] as unknown as PendingCreditHoldModel) ??
  model<PendingCreditHoldDocument>('PendingCreditHold', PendingCreditHoldSchema);
export const pendingCreditHoldRepository = new PendingCreditHoldRepository(PendingCreditHoldModel);
