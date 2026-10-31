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
  /** Stripe Radar blocked a charge on this intent (`outcome.type === 'blocked'`). */
  radarBlocked: boolean;
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
  | 'radarBlocked'
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
    radarBlocked: { type: Boolean, default: false },
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
    radarBlocked: row.radarBlocked ?? false,
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
   * (a Checkout subscription). `changed` is false when the update added nothing new (same outcome,
   * no new card): a Stripe redelivery, which must not alert a second time.
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
    radarBlocked?: boolean;
    hostingNetwork: boolean | null;
  }): Promise<{ attempt: PaymentAttempt; changed: boolean }> {
    const {
      paymentIntentId,
      cardFingerprint,
      outcome,
      riskLevel,
      radarBlocked,
      userId,
      kind,
      amount,
      currency,
      hostingNetwork,
    } = input;
    // The pre-image says what this delivery added; the second read returns the merged row.
    const before = await PaymentAttemptModel.findOneAndUpdate(
      { paymentIntentId },
      {
        $set: {
          outcome,
          ...(riskLevel !== null && { riskLevel }),
          ...(amount !== null && { amount, currency }),
          // Sticky: a later successful retry on the same intent does not erase that Radar blocked it.
          ...(radarBlocked && { radarBlocked: true }),
        },
        $setOnInsert: { userId, kind, ipHash: null, hostingNetwork },
        ...(cardFingerprint && { $addToSet: { cardFingerprints: cardFingerprint } }),
      },
      { upsert: true, new: false }
    ).lean();
    const after = await PaymentAttemptModel.findOne({ paymentIntentId }).lean();
    if (!after) throw new Error(`PaymentAttempt upsert left no row for ${paymentIntentId}`);
    const changed =
      !before ||
      before.outcome !== outcome ||
      (cardFingerprint !== null && !(before.cardFingerprints ?? []).includes(cardFingerprint));
    return { attempt: toAttempt(after), changed };
  }

  /** Distinct accounts that have used this card, successfully or not. Null when the scan is truncated. */
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

  /** Radar-blocked attempts by this account, and from this network, since `since`. Null = unknown. */
  async countRadarBlocked(input: {
    userId: string;
    ipHash: string | null;
    since: Date;
  }): Promise<{ account: number; network: number | null }> {
    const count = (filter: Record<string, unknown>) =>
      PaymentAttemptModel.countDocuments({ ...filter, radarBlocked: true, createdAt: { $gte: input.since } }).maxTimeMS(
        2000
      );
    const [account, network] = await Promise.all([
      count({ userId: input.userId }),
      input.ipHash ? count({ ipHash: input.ipHash }) : null,
    ]);
    return { account, network };
  }

  /** The cards and payment networks this account has used, for linking it to other accounts. */
  async linkKeysForUser(userId: string): Promise<{ cardFingerprints: string[]; ipHashes: string[] }> {
    const rows = await PaymentAttemptModel.find({ userId })
      .select({ cardFingerprints: 1, ipHash: 1, _id: 0 })
      .limit(MAX_COUNTED_ROWS)
      .maxTimeMS(2000)
      .lean();
    return {
      cardFingerprints: [...new Set(rows.flatMap(row => row.cardFingerprints ?? []))],
      ipHashes: [...new Set(rows.map(row => row.ipHash).filter((hash): hash is string => Boolean(hash)))],
    };
  }

  /** Other accounts that used any of these cards, or paid from any of these networks. Capped at `limit` each. */
  async findLinkedUserIds(input: {
    userId: string;
    cardFingerprints: string[];
    ipHashes: string[];
    limit: number;
  }): Promise<{ byCard: string[]; byNetwork: string[] }> {
    const others = async (filter: Record<string, unknown>): Promise<string[]> => {
      const userIds: string[] = await PaymentAttemptModel.distinct('userId', {
        ...filter,
        userId: { $ne: input.userId },
      }).maxTimeMS(2000);
      return userIds.slice(0, input.limit);
    };
    const [byCard, byNetwork] = await Promise.all([
      input.cardFingerprints.length > 0 ? others({ cardFingerprints: { $in: input.cardFingerprints } }) : [],
      input.ipHashes.length > 0 ? others({ ipHash: { $in: input.ipHashes } }) : [],
    ]);
    return { byCard, byNetwork };
  }
}

export const paymentAttemptRepository = new PaymentAttemptRepository();
