import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    queueLabel: { type: String, required: true },
    payloadHash: { type: String, required: true },
    suggestionId: { type: String, required: true },
  },
  { timestamps: true }
);

// No TTL: a replay returning under a new SQS id must not regain autonomous eligibility.
schema.index({ queueLabel: 1, payloadHash: 1 }, { unique: true });

const model =
  (mongoose.models.DlqTriageReplay as
    | mongoose.Model<{
        queueLabel: string;
        payloadHash: string;
        suggestionId: string;
      }>
    | undefined) ?? mongoose.model('DlqTriageReplay', schema);

export const dlqTriageReplayRepository = {
  async claim(queueLabel: string, payloadHash: string, suggestionId: string): Promise<boolean> {
    try {
      await model.create({ queueLabel, payloadHash, suggestionId });
      return true;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) return false;
      throw error;
    }
  },
};
