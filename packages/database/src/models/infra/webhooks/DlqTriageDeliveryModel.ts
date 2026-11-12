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

const model =
  (mongoose.models.DlqTriageDelivery as mongoose.Model<Delivery> | undefined) ??
  mongoose.model<Delivery>('DlqTriageDelivery', schema);

export const dlqTriageDeliveryRepository = {
  async claim(key: string): Promise<boolean> {
    try {
      // A crash after the claim is ambiguous too: never automatically resend it.
      await model.create({ key, state: 'unconfirmed' });
      return true;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) return false;
      throw error;
    }
  },
  async delivered(key: string): Promise<void> {
    await model.updateOne({ key }, { $set: { state: 'delivered' } });
  },
};
