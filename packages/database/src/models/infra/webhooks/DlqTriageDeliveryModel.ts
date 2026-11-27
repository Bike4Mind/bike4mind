import mongoose from 'mongoose';

interface Delivery {
  key: string;
  state: 'unconfirmed' | 'delivered';
}

const schema = new mongoose.Schema<Delivery>(
  {
    key: { type: String, required: true },
    state: { type: String, enum: ['unconfirmed', 'delivered'], required: true },
  },
  { timestamps: true }
);
schema.index({ key: 1 }, { unique: true });
// Longer than SQS retention: expiring a claim cannot repost a live dead letter.
schema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export const DlqTriageDeliveryModel =
  (mongoose.models.DlqTriageDelivery as mongoose.Model<Delivery> | undefined) ??
  mongoose.model<Delivery>('DlqTriageDelivery', schema);

export const dlqTriageDeliveryRepository = {
  async claim(key: string): Promise<boolean> {
    try {
      // A crash after the claim is ambiguous too: never automatically resend it.
      await DlqTriageDeliveryModel.create({ key, state: 'unconfirmed' });
      return true;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) return false;
      throw error;
    }
  },
  async delivered(key: string): Promise<void> {
    await DlqTriageDeliveryModel.updateOne({ key }, { $set: { state: 'delivered' } }, { maxTimeMS: 2_000 });
  },
  async release(key: string): Promise<void> {
    await DlqTriageDeliveryModel.deleteOne({ key, state: 'unconfirmed' }, { maxTimeMS: 2_000 });
  },
};
