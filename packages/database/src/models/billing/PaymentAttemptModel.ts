import mongoose, { Document, Model, model, Schema } from 'mongoose';

export type PaymentAttemptKind = 'credits' | 'subscription';
export type PaymentAttemptOutcome = 'started' | 'succeeded' | 'failed';

/**
 * One card payment (a Stripe payment intent) as the payment-risk alert sees it. The start-payment
 * route stamps the network it came from; the Stripe webhook adds every card fingerprint that tried
 * to pay and the final outcome. Holds no raw IP and no card details: the IP is a keyed HMAC
 * (hashSignupNetwork) and a card fingerprint is Stripe's opaque per-card id.
 */
export interface IPaymentAttemptDocument extends Document {
  paymentIntentId: string;
  userId: string;
  kind: PaymentAttemptKind;
  /** Minor units (cents). */
  amount: number | null;
  currency: string | null;
  cardFingerprints: string[];
  outcome: PaymentAttemptOutcome;
  /** Stripe Radar `outcome.risk_level` of the latest charge, when Stripe reported one. */
  riskLevel: string | null;
  ipHash: string | null;
  /** Started from a datacenter ASN or a WAF anonymous-IP address; null when unknown. */
  hostingNetwork: boolean | null;
  createdAt: Date;
  updatedAt: Date;
}

export type PaymentAttempt = Pick<
  IPaymentAttemptDocument,
  | 'paymentIntentId'
  | 'userId'
  | 'kind'
  | 'amount'
  | 'currency'
  | 'cardFingerprints'
  | 'outcome'
  | 'riskLevel'
  | 'ipHash'
  | 'hostingNetwork'
  | 'createdAt'
>;

/** 90 days: longer than any card window, long enough to link accounts that share a card. */
export const PAYMENT_ATTEMPT_RETENTION_SECONDS = 90 * 24 * 60 * 60;

// A bigger result set is reported as unknown (null), never as a low count.
const MAX_COUNTED_ROWS = 1_000;

const PaymentAttemptSchema = new Schema<IPaymentAttemptDocument>(
  {
    paymentIntentId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    kind: { type: String, enum: ['credits', 'subscription'], required: true },
    amount: { type: Number, default: null },
    currency: { type: String, default: null },
    cardFingerprints: { type: [String], default: [] },
    outcome: { type: String, enum: ['started', 'succeeded', 'failed'], required: true },
    riskLevel: { type: String, default: null },
    ipHash: { type: String, default: null },
    hostingNetwork: { type: Boolean, default: null },
  },
  { timestamps: true, versionKey: false }
);

PaymentAttemptSchema.index({ createdAt: 1 }, { expireAfterSeconds: PAYMENT_ATTEMPT_RETENTION_SECONDS });
PaymentAttemptSchema.index({ cardFingerprints: 1 });
PaymentAttemptSchema.index({ userId: 1, createdAt: 1 });
PaymentAttemptSchema.index({ ipHash: 1, createdAt: 1 });

export const PaymentAttemptModel: Model<IPaymentAttemptDocument> =
  (mongoose.models.PaymentAttempt as unknown as Model<IPaymentAttemptDocument>) ??
  model<IPaymentAttemptDocument>('PaymentAttempt', PaymentAttemptSchema);

const toAttempt = (doc: IPaymentAttemptDocument | Record<string, unknown>): PaymentAttempt => {
  const row = doc as unknown as PaymentAttempt;
  return {
    paymentIntentId: row.paymentIntentId,
    userId: row.userId,
    kind: row.kind,
    amount: row.amount ?? null,
    currency: row.currency ?? null,
    cardFingerprints: row.cardFingerprints ?? [],
    outcome: row.outcome,
    riskLevel: row.riskLevel ?? null,
    ipHash: row.ipHash ?? null,
    hostingNetwork: row.hostingNetwork ?? null,
    createdAt: row.createdAt,
  };
};

class PaymentAttemptRepository {
  /** Records where a payment started. Idempotent per payment intent; never overwrites a later outcome. */
  async recordStart(input: {
    paymentIntentId: string;
    userId: string;
    kind: PaymentAttemptKind;
    amount: number;
    currency: string;
    ipHash: string | null;
    hostingNetwork: boolean | null;
  }): Promise<void> {
    const { paymentIntentId, ...fields } = input;
    await PaymentAttemptModel.updateOne(
      { paymentIntentId },
      { $setOnInsert: { ...fields, outcome: 'started', cardFingerprints: [] } },
      { upsert: true }
    );
  }

  /**
   * Adds a Stripe-reported outcome to the attempt, creating it when start-payment never saw it
   * (a Checkout subscription). Returns the updated attempt.
   */
  async recordOutcome(input: {
    paymentIntentId: string;
    userId: string;
    kind: PaymentAttemptKind;
    amount: number | null;
    currency: string | null;
    outcome: Exclude<PaymentAttemptOutcome, 'started'>;
    cardFingerprint: string | null;
    riskLevel: string | null;
    hostingNetwork: boolean | null;
  }): Promise<PaymentAttempt> {
    const { paymentIntentId, cardFingerprint, outcome, riskLevel, userId, kind, amount, currency, hostingNetwork } =
      input;
    const doc = await PaymentAttemptModel.findOneAndUpdate(
      { paymentIntentId },
      {
        $set: { outcome, ...(riskLevel !== null && { riskLevel }), ...(amount !== null && { amount, currency }) },
        $setOnInsert: { userId, kind, ipHash: null, hostingNetwork },
        ...(cardFingerprint && { $addToSet: { cardFingerprints: cardFingerprint } }),
      },
      { upsert: true, new: true }
    ).lean();
    if (!doc) throw new Error(`PaymentAttempt upsert returned nothing for ${paymentIntentId}`);
    return toAttempt(doc);
  }

  /** Distinct accounts that have paid, or tried to pay, with this card. Null when the scan is truncated. */
  async countAccountsForCard(cardFingerprint: string): Promise<number | null> {
    const userIds = await PaymentAttemptModel.distinct('userId', { cardFingerprints: cardFingerprint }).maxTimeMS(2000);
    return userIds.length > MAX_COUNTED_ROWS ? null : userIds.length;
  }

  /** Distinct cards tried by this account, and from this network, since `since`. Null = unknown. */
  async countRecentCards(input: {
    userId: string;
    ipHash: string | null;
    since: Date;
  }): Promise<{ userCards: number | null; networkCards: number | null }> {
    const count = async (filter: Record<string, unknown>): Promise<number | null> => {
      const rows = await PaymentAttemptModel.find({ ...filter, createdAt: { $gte: input.since } })
        .select({ cardFingerprints: 1, _id: 0 })
        .limit(MAX_COUNTED_ROWS + 1)
        .maxTimeMS(2000)
        .lean();
      if (rows.length > MAX_COUNTED_ROWS) return null;
      return new Set(rows.flatMap(row => row.cardFingerprints ?? [])).size;
    };
    const [userCards, networkCards] = await Promise.all([
      count({ userId: input.userId }),
      input.ipHash ? count({ ipHash: input.ipHash }) : null,
    ]);
    return { userCards, networkCards };
  }
}

export const paymentAttemptRepository = new PaymentAttemptRepository();
