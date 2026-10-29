import { mongoose } from '@bike4mind/database';

export interface CardVerificationRecord {
  verificationId: string;
  userId: string;
  environment: string;
  livemode: boolean;
  customerId?: string;
  setupIntentId?: string;
  paymentMethodId?: string;
  identityDigest?: string;
  credits: number;
  saveCard: boolean;
  state: 'pending' | 'verified' | 'granted' | 'refused';
  detached: boolean;
  createdAt?: Date;
}

const schema = new mongoose.Schema<CardVerificationRecord>(
  {
    verificationId: { type: String, required: true, immutable: true },
    userId: { type: String, required: true, immutable: true },
    environment: { type: String, required: true, immutable: true },
    livemode: { type: Boolean, required: true, immutable: true },
    customerId: String,
    setupIntentId: String,
    paymentMethodId: String,
    identityDigest: String,
    credits: { type: Number, required: true, immutable: true, min: 1 },
    saveCard: { type: Boolean, required: true, immutable: true },
    state: { type: String, enum: ['pending', 'verified', 'granted', 'refused'], required: true },
    detached: { type: Boolean, required: true },
  },
  { timestamps: true, strict: 'throw' }
);

schema.index({ verificationId: 1 }, { unique: true });
schema.index({ userId: 1, state: 1 });

export const CardVerification =
  (mongoose.models.CardVerification as mongoose.Model<CardVerificationRecord> | undefined) ??
  mongoose.model<CardVerificationRecord>('CardVerification', schema);
