import mongoose, { Schema, Document, Model } from 'mongoose';
import type { IPasskeyChallengeRepository, PasskeyChallengePurpose } from '@bike4mind/common';

/**
 * A shared store, not an in-memory map: the API runs on Lambda, so the instance that issued
 * the options is usually not the one that verifies the response.
 */
export interface IPasskeyChallengeDocument extends Document {
  userId: string;
  purpose: PasskeyChallengePurpose;
  challenge: string;
  createdAt: Date;
}

/** Matches the ceremony timeout handed to the browser, plus slack for the round trip. */
export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;

const passkeyChallengeSchema = new Schema<IPasskeyChallengeDocument>({
  userId: { type: String, required: true },
  purpose: { type: String, enum: ['registration', 'authentication'], required: true },
  challenge: { type: String, required: true },
  createdAt: { type: Date, required: true, default: Date.now },
});

passkeyChallengeSchema.index({ userId: 1, purpose: 1 }, { unique: true });
passkeyChallengeSchema.index({ createdAt: 1 }, { expireAfterSeconds: PASSKEY_CHALLENGE_TTL_MS / 1000 });

const modelName = 'PasskeyChallenge';

export const PasskeyChallengeModel: Model<IPasskeyChallengeDocument> =
  mongoose.models[modelName] || mongoose.model<IPasskeyChallengeDocument>(modelName, passkeyChallengeSchema);

export class PasskeyChallengeRepository implements IPasskeyChallengeRepository {
  /** Replaces any outstanding challenge for the same user + purpose, so only the newest ceremony can complete. */
  async issue(userId: string, purpose: PasskeyChallengePurpose, challenge: string): Promise<void> {
    await PasskeyChallengeModel.updateOne(
      { userId, purpose },
      { $set: { challenge, createdAt: new Date() } },
      { upsert: true }
    );
  }

  async consume(userId: string, purpose: PasskeyChallengePurpose): Promise<string | null> {
    // The TTL reaper only sweeps about once a minute, so expiry is also enforced here.
    const doc = await PasskeyChallengeModel.findOneAndDelete({
      userId,
      purpose,
      createdAt: { $gt: new Date(Date.now() - PASSKEY_CHALLENGE_TTL_MS) },
    });
    return doc?.challenge ?? null;
  }
}

export const passkeyChallengeRepository = new PasskeyChallengeRepository();
