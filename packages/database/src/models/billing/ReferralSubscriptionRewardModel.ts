import mongoose, { Model, Schema, model } from 'mongoose';

export const REFERRAL_REWARD_STEPS = ['first_payment', 'second_payment'] as const;
export type ReferralRewardStep = (typeof REFERRAL_REWARD_STEPS)[number];

// pending: held, not yet usable. released: credited to the inviter (or a step whose amount was 0, which
// never holds). cancelled: closed before payout. taken_back: refunded in full after release.
export const REFERRAL_REWARD_STATUSES = ['pending', 'released', 'cancelled', 'taken_back'] as const;
export type ReferralRewardStatus = (typeof REFERRAL_REWARD_STATUSES)[number];

export type ReferralRewardCloseReason = 'refunded' | 'disputed' | 'inviter_blocked' | 'payer_blocked';

/**
 * An inviter's reward for one paid Professional invoice of the friend they invited. The credits are only
 * granted when the hold ends (status released), so a pending row never touches a balance. Written from the
 * paid-invoice worker and unique on the invoice id, so a webhook retry cannot create a second reward.
 */
export type ReferralSubscriptionReward = {
  id: string;
  invoiceId: string;
  paymentIntentId?: string;
  payerId: string;
  inviterId: string;
  step: ReferralRewardStep;
  credits: number;
  releaseAt: Date;
  status: ReferralRewardStatus;
  releasedAt?: Date;
  closedAt?: Date;
  closeReason?: ReferralRewardCloseReason;
  // Share of `credits` the refunds so far entitle us to take back, and what was actually taken (never more
  // than the inviter still had). Kept apart so a spent part is not clawed from later credits on a retry.
  refundTargetCredits: number;
  takenBackCredits: number;
  createdAt: Date;
};

export type NewReferralSubscriptionReward = Pick<
  ReferralSubscriptionReward,
  'invoiceId' | 'paymentIntentId' | 'payerId' | 'inviterId' | 'step' | 'credits' | 'releaseAt'
>;

type ReferralSubscriptionRewardDocument = Omit<ReferralSubscriptionReward, 'id'> & {
  _id: mongoose.Types.ObjectId;
  // Marks the payer's step as used so two concurrent invoices cannot both take it (sparse unique index
  // below). Kept through release, take-back and a blocked cancel, so a friend's later payments never
  // re-earn a step that was already paid or spent; only a refund inside the hold unsets it.
  stepKey?: string;
};

const ReferralSubscriptionRewardSchema = new Schema<ReferralSubscriptionRewardDocument>(
  {
    invoiceId: { type: String, required: true, unique: true },
    paymentIntentId: { type: String },
    payerId: { type: String, required: true },
    inviterId: { type: String, required: true },
    step: { type: String, required: true, enum: REFERRAL_REWARD_STEPS },
    credits: { type: Number, required: true },
    releaseAt: { type: Date, required: true },
    status: { type: String, required: true, enum: REFERRAL_REWARD_STATUSES, default: 'pending' },
    releasedAt: { type: Date },
    closedAt: { type: Date },
    closeReason: { type: String },
    refundTargetCredits: { type: Number, required: true, default: 0 },
    takenBackCredits: { type: Number, required: true, default: 0 },
    stepKey: { type: String },
  },
  { timestamps: true }
);

ReferralSubscriptionRewardSchema.index({ status: 1, releaseAt: 1 });
ReferralSubscriptionRewardSchema.index({ paymentIntentId: 1 }, { sparse: true });
ReferralSubscriptionRewardSchema.index({ payerId: 1 });
ReferralSubscriptionRewardSchema.index({ stepKey: 1 }, { unique: true, sparse: true });

type ReferralSubscriptionRewardModel = Model<ReferralSubscriptionRewardDocument>;

const toReward = (doc: ReferralSubscriptionRewardDocument): ReferralSubscriptionReward => ({
  id: doc._id.toString(),
  invoiceId: doc.invoiceId,
  ...(doc.paymentIntentId ? { paymentIntentId: doc.paymentIntentId } : {}),
  payerId: doc.payerId,
  inviterId: doc.inviterId,
  step: doc.step,
  credits: doc.credits,
  releaseAt: doc.releaseAt,
  status: doc.status,
  ...(doc.releasedAt ? { releasedAt: doc.releasedAt } : {}),
  ...(doc.closedAt ? { closedAt: doc.closedAt } : {}),
  ...(doc.closeReason ? { closeReason: doc.closeReason } : {}),
  refundTargetCredits: doc.refundTargetCredits ?? 0,
  takenBackCredits: doc.takenBackCredits ?? 0,
  createdAt: doc.createdAt,
});

const isDuplicateKeyError = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;

export class ReferralSubscriptionRewardRepository {
  constructor(private readonly model: ReferralSubscriptionRewardModel) {}

  /**
   * Null when the invoice already has a reward or the payer's step is already used. A step whose amount is
   * 0 is still recorded, already released and never held, so it keeps counting toward the payer's steps.
   */
  async create(input: NewReferralSubscriptionReward, now = new Date()): Promise<ReferralSubscriptionReward | null> {
    try {
      const doc = await this.model.create({
        ...input,
        ...(input.credits > 0 ? { status: 'pending' } : { status: 'released', releasedAt: now }),
        stepKey: `${input.payerId}:${input.step}`,
      });
      return toReward(doc.toObject());
    } catch (err) {
      if (isDuplicateKeyError(err)) return null;
      throw err;
    }
  }

  async findByInvoiceId(invoiceId: string): Promise<ReferralSubscriptionReward | null> {
    const doc = await this.model.findOne({ invoiceId }).lean<ReferralSubscriptionRewardDocument>();
    return doc ? toReward(doc) : null;
  }

  async findByPaymentIntentId(paymentIntentId: string): Promise<ReferralSubscriptionReward | null> {
    const doc = await this.model.findOne({ paymentIntentId }).lean<ReferralSubscriptionRewardDocument>();
    return doc ? toReward(doc) : null;
  }

  /** Steps of this payer that are used: the 1st and 2nd payment each count once. */
  async findClaimedSteps(payerId: string): Promise<ReferralRewardStep[]> {
    return this.model.distinct('step', { payerId, stepKey: { $exists: true } });
  }

  /** Oldest first, so a backlog drains in release order over successive runs. */
  async findDue(now: Date, limit: number): Promise<ReferralSubscriptionReward[]> {
    const docs = await this.model
      .find({ status: 'pending', releaseAt: { $lte: now } })
      .sort({ releaseAt: 1 })
      .limit(limit)
      .lean<ReferralSubscriptionRewardDocument[]>();
    return docs.map(toReward);
  }

  /** Atomically takes ownership of a due reward; null means another caller already did. Share a transaction with the grant. */
  async claimForRelease(id: string, now: Date): Promise<ReferralSubscriptionReward | null> {
    const doc = await this.model
      .findOneAndUpdate(
        { _id: id, status: 'pending', releaseAt: { $lte: now } },
        { $set: { status: 'released', releasedAt: now } },
        { new: true }
      )
      .lean<ReferralSubscriptionRewardDocument>();
    return doc ? toReward(doc) : null;
  }

  /**
   * Closes a reward that is still held; false when it was already released or closed. Only a refund frees
   * the payer's step, since nothing was paid. Any other reason keeps it used, so the friend's later
   * payments cannot earn the step again.
   */
  async cancelPending(id: string, reason: ReferralRewardCloseReason, now: Date): Promise<boolean> {
    const result = await this.model.updateOne(
      { _id: id, status: 'pending' },
      {
        $set: { status: 'cancelled', closedAt: now, closeReason: reason },
        ...(reason === 'refunded' ? { $unset: { stepKey: '' } } : {}),
      }
    );
    return result.modifiedCount === 1;
  }

  /**
   * Records a refund against a released reward, guarded by the target the caller read so a concurrent or
   * redelivered event applies once (false means the target moved: re-read and retry). A full refund marks
   * the reward taken_back but keeps the payer's step used. Share a transaction with the balance take-back.
   */
  async recordTakeBack(
    id: string,
    previousTarget: number,
    update: { refundTargetCredits: number; takenBackCredits: number; fullyRefunded: boolean },
    now: Date
  ): Promise<boolean> {
    const result = await this.model.updateOne(
      { _id: id, status: 'released', refundTargetCredits: previousTarget },
      {
        $set: {
          refundTargetCredits: update.refundTargetCredits,
          takenBackCredits: update.takenBackCredits,
          ...(update.fullyRefunded ? { status: 'taken_back', closedAt: now, closeReason: 'refunded' } : {}),
        },
      }
    );
    return result.modifiedCount === 1;
  }
}

export const ReferralSubscriptionRewardModel =
  (mongoose.models['ReferralSubscriptionReward'] as unknown as ReferralSubscriptionRewardModel) ??
  model<ReferralSubscriptionRewardDocument>('ReferralSubscriptionReward', ReferralSubscriptionRewardSchema);
export const referralSubscriptionRewardRepository = new ReferralSubscriptionRewardRepository(
  ReferralSubscriptionRewardModel
);
