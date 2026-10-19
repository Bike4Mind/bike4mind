import mongoose, { Model, Schema, model } from 'mongoose';
import { CreditHolderType, type CreditHoldRecord } from '@bike4mind/common';

/**
 * A request's reserved credits. Refund and sweep delete pending rows in the same transaction as the
 * balance increment. Settlement instead commits a receipt together with its refund, member usage and
 * ledger. A lost commit acknowledgement can then be reconciled without charging or refunding twice.
 *
 * expiresAt is never a TTL index. Only settledAt expires: those rows describe completed money movement.
 */
export type PendingCreditHold = CreditHoldRecord & {
  id: string;
  featureLabel: string;
  expiresAt: Date;
  settledAt?: Date;
  settledCredits?: number;
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
    settledAt: { type: Date },
    settledCredits: { type: Number },
  },
  { timestamps: true }
);

PendingCreditHoldSchema.index({ expiresAt: 1 });
// Only completed settlements have this field: TTL never deletes an outstanding hold.
PendingCreditHoldSchema.index({ settledAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

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
  ...(doc.settledAt ? { settledAt: doc.settledAt, settledCredits: doc.settledCredits } : {}),
});

export class PendingCreditHoldRepository {
  constructor(private readonly model: PendingCreditHoldModel) {}

  async record(hold: CreditHoldRecord, featureLabel: string, expiresAt: Date): Promise<PendingCreditHold> {
    const doc = await this.model.create({ ...hold, featureLabel, expiresAt });
    return toPendingCreditHold(doc.toObject());
  }

  /** Must share a transaction with settlement's balance, member usage and ledger writes. */
  async markSettled(id: string, settledCredits: number): Promise<boolean> {
    const result = await this.model.updateOne(
      { _id: id, settledAt: { $exists: false } },
      { $set: { settledAt: new Date(), settledCredits } }
    );
    return result.modifiedCount === 1;
  }

  /** Reconciles a committed settlement whose transaction acknowledgement was lost. */
  async findSettlement(id: string): Promise<number | null> {
    const doc = await this.model.findById(id).lean<PendingCreditHoldDocument>();
    return doc?.settledAt ? (doc.settledCredits ?? null) : null;
  }

  /** Atomically takes ownership of the hold; null means another caller already claimed it. */
  async claim(id: string): Promise<PendingCreditHold | null> {
    const doc = await this.model
      .findOneAndDelete({ _id: id, settledAt: { $exists: false } })
      .lean<PendingCreditHoldDocument>();
    return doc ? toPendingCreditHold(doc) : null;
  }

  /** Like claim, but only while the hold is still expired at `now`. */
  async claimExpired(id: string, now: Date): Promise<PendingCreditHold | null> {
    const doc = await this.model
      .findOneAndDelete({ _id: id, expiresAt: { $lte: now }, settledAt: { $exists: false } })
      .lean<PendingCreditHoldDocument>();
    return doc ? toPendingCreditHold(doc) : null;
  }

  /** Oldest first, so a backlog drains in expiry order over successive sweeps. */
  async findExpired(now: Date, limit: number): Promise<PendingCreditHold[]> {
    const docs = await this.model
      .find({ expiresAt: { $lte: now }, settledAt: { $exists: false } })
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
