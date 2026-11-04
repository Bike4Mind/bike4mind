import mongoose, { Schema } from 'mongoose';

export type CreditRewardSource = 'gear' | 'referral_first_answer';
/** `paused` is a blocked account's reward: out of the queue, its heldAt kept so unblock restores its place. */
export type HeldCreditRewardStatus = 'held' | 'paid' | 'void' | 'paused';

export type HeldCreditReward = {
  id: string;
  transactionId: string;
  userId: string;
  credits: number;
  source: CreditRewardSource;
  reason: string;
  description: string;
  metadata?: Record<string, unknown>;
  heldAt: Date;
  status: HeldCreditRewardStatus;
  paidAt?: Date | null;
};

type HeldCreditRewardDoc = Omit<HeldCreditReward, 'id'>;

const heldCreditRewardSchema = new Schema<HeldCreditRewardDoc>(
  {
    // The ledger transactionId the reward pays under once released.
    transactionId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    credits: { type: Number, required: true, min: 1 },
    source: { type: String, enum: ['gear', 'referral_first_answer'], required: true },
    reason: { type: String, required: true },
    description: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed },
    heldAt: { type: Date, required: true },
    status: { type: String, enum: ['held', 'paid', 'void', 'paused'], required: true, default: 'held' },
    paidAt: { type: Date, default: null },
  },
  { versionKey: false, timestamps: true }
);

heldCreditRewardSchema.index({ status: 1, heldAt: 1, _id: 1 });
// pauseForUser / resumeForUser filter on one user's rows by status.
heldCreditRewardSchema.index({ userId: 1, status: 1 });

export const HeldCreditRewardModel =
  (mongoose.models.HeldCreditReward as mongoose.Model<HeldCreditRewardDoc>) ??
  mongoose.model('HeldCreditReward', heldCreditRewardSchema);

const toReward = (row: HeldCreditRewardDoc & { _id: unknown }): HeldCreditReward => {
  const { _id, ...rest } = row;
  return { ...rest, id: String(_id) };
};

/** Structural match for creditService.HeldCreditRewardRepository (b4m-core/services). */
export const heldCreditRewardRepository = {
  async hold(reward: Omit<HeldCreditReward, 'id' | 'heldAt' | 'status' | 'paidAt'>, heldAt: Date = new Date()) {
    // A repeat hold keeps the first row and its place in the queue.
    await HeldCreditRewardModel.updateOne(
      { transactionId: reward.transactionId },
      { $setOnInsert: { ...reward, heldAt, status: 'held' } },
      { upsert: true }
    );
  },
  async findByTransactionIds(transactionIds: string[]): Promise<HeldCreditReward[]> {
    if (transactionIds.length === 0) return [];
    const rows = await HeldCreditRewardModel.find({ transactionId: { $in: transactionIds } }).lean();
    return rows.map(toReward);
  },
  async oldestHeldCredits(maxCredits?: number): Promise<number | null> {
    const row = await HeldCreditRewardModel.findOne({
      status: 'held',
      ...(maxCredits !== undefined ? { credits: { $lte: maxCredits } } : {}),
    })
      .sort({ heldAt: 1, _id: 1 })
      .select('credits')
      .lean();
    return row?.credits ?? null;
  },
  async listHeld(limit: number, maxCredits?: number): Promise<HeldCreditReward[]> {
    const rows = await HeldCreditRewardModel.find({
      status: 'held',
      ...(maxCredits !== undefined ? { credits: { $lte: maxCredits } } : {}),
    })
      .sort({ heldAt: 1, _id: 1 })
      .limit(limit)
      .lean();
    return rows.map(toReward);
  },
  /** Takes a user's queued rewards out of the queue; every queue query reads `held` only, so none pays or blocks the head. */
  async pauseForUser(userId: string): Promise<number> {
    const { modifiedCount } = await HeldCreditRewardModel.updateMany(
      { userId, status: 'held' },
      { $set: { status: 'paused' } }
    );
    return modifiedCount;
  },
  /** Takes one queued reward out of the queue, leaving the user's other rows as they are. */
  async pauseOne(transactionId: string): Promise<number> {
    const { modifiedCount } = await HeldCreditRewardModel.updateOne(
      { transactionId, status: 'held' },
      { $set: { status: 'paused' } }
    );
    return modifiedCount;
  },
  /** Puts a user's paused rewards back in the queue at their original place. */
  async resumeForUser(userId: string): Promise<number> {
    const { modifiedCount } = await HeldCreditRewardModel.updateMany(
      { userId, status: 'paused' },
      { $set: { status: 'held' } }
    );
    return modifiedCount;
  },
  async settle(transactionId: string, status: 'paid' | 'void', at: Date = new Date()) {
    await HeldCreditRewardModel.updateOne(
      { transactionId, status: 'held' },
      { $set: { status, ...(status === 'paid' ? { paidAt: at } : {}) } }
    );
  },
};
