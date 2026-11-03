import mongoose, { Document, Model, model, Schema } from 'mongoose';

/**
 * The automatic responses to one payment-risk trigger (an early fraud warning, a dispute, an
 * account lock), keyed so a Stripe redelivery or a second trigger for the same thing acts once.
 * Each step is claimed before it runs, so a step that must not repeat (a credit clawback, an
 * alert) runs at most once even when a later step fails and Stripe retries the event. Steps that
 * are safe to repeat (a Stripe refund with an idempotency key, a lock) are not claimed.
 */
export interface IPaymentRiskActionDocument extends Document {
  key: string;
  userId: string | null;
  steps: string[];
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const PaymentRiskActionSchema = new Schema<IPaymentRiskActionDocument>(
  {
    key: { type: String, required: true, unique: true },
    userId: { type: String, default: null },
    steps: { type: [String], default: [] },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

export const PaymentRiskActionModel: Model<IPaymentRiskActionDocument> =
  (mongoose.models.PaymentRiskAction as unknown as Model<IPaymentRiskActionDocument>) ??
  model<IPaymentRiskActionDocument>('PaymentRiskAction', PaymentRiskActionSchema);

const isDuplicateKey = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 11000;

class PaymentRiskActionRepository {
  async isCompleted(key: string): Promise<boolean> {
    const doc = await PaymentRiskActionModel.findOne({ key, completedAt: { $ne: null } })
      .select({ _id: 1 })
      .lean();
    return doc !== null;
  }

  /**
   * Claims `step` for `key`; true when this caller won it and should run it. The upsert misses a
   * record that already lists the step and then collides on the unique key. That collision is also
   * what a concurrent first claim of another step looks like, so it retries once without the upsert.
   */
  async claimStep(key: string, step: string, userId: string | null): Promise<boolean> {
    const filter = { key, steps: { $ne: step } };
    const update = { $addToSet: { steps: step }, $setOnInsert: { userId } };
    try {
      await PaymentRiskActionModel.updateOne(filter, update, { upsert: true });
      return true;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const { modifiedCount } = await PaymentRiskActionModel.updateOne(filter, { $addToSet: { steps: step } });
      return modifiedCount === 1;
    }
  }

  async markCompleted(key: string, userId: string | null): Promise<void> {
    await PaymentRiskActionModel.updateOne(
      { key },
      { $set: { completedAt: new Date() }, $setOnInsert: { userId } },
      { upsert: true }
    );
  }
}

export const paymentRiskActionRepository = new PaymentRiskActionRepository();
