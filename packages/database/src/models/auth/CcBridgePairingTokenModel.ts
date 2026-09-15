import mongoose, { Model, Schema, model } from 'mongoose';

const ModelName = 'CcBridgePairingToken';

/**
 * One-time pairing token minted when a user clicks "Connect Claude Code".
 * Shipped inside the downloaded zip as `pair.json` and redeemed by the
 * bridge on first run for a durable API key + `CcBridgeDevice` record.
 *
 * Lifetime is bounded by a TTL index on `expiresAt`; tokens are also burned
 * on redemption (`redeemedAt`) so a leaked zip can't be replayed.
 */
export interface ICcBridgePairingTokenDoc {
  _id: string;
  userId: string;
  /** bcrypt hash of the plaintext token - plaintext never persisted. */
  tokenHash: string;
  /** First 16 chars of the plaintext token (for log correlation, non-sensitive). */
  tokenPrefix: string;
  /** Label the user (or the download UI) provided for the device being paired. */
  deviceLabel?: string;
  /** Platform string the download was issued for, e.g. `darwin-arm64`. */
  platform?: string;
  /** Set once; prevents replay. */
  redeemedAt?: Date;
  /** Device record produced by redemption - for audit / one-to-one mapping. */
  redeemedDeviceId?: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface ICcBridgePairingTokenModel extends Model<ICcBridgePairingTokenDoc> {}

const CcBridgePairingTokenSchema = new Schema<ICcBridgePairingTokenDoc>(
  {
    userId: { type: String, required: true },
    tokenHash: { type: String, required: true },
    tokenPrefix: { type: String, required: true },
    deviceLabel: { type: String },
    platform: { type: String },
    redeemedAt: { type: Date },
    redeemedDeviceId: { type: String },
    expiresAt: { type: Date, required: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform: function (_doc, ret: Record<string, unknown>) {
        delete ret.tokenHash;
        return ret;
      },
    },
  }
);

// TTL safety net - Mongo sweeps expired tokens even if nothing reads them.
CcBridgePairingTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
CcBridgePairingTokenSchema.index({ tokenPrefix: 1 });
CcBridgePairingTokenSchema.index({ userId: 1, createdAt: -1 });

export const CcBridgePairingToken: ICcBridgePairingTokenModel =
  (mongoose.models[ModelName] as ICcBridgePairingTokenModel) ||
  model<ICcBridgePairingTokenDoc, ICcBridgePairingTokenModel>(ModelName, CcBridgePairingTokenSchema);

export const ccBridgePairingTokenRepository = {
  async create(doc: Omit<ICcBridgePairingTokenDoc, '_id' | 'createdAt' | 'updatedAt'>) {
    const created = await CcBridgePairingToken.create(doc);
    return created.toObject();
  },

  /**
   * Look up every unredeemed, unexpired token whose prefix matches.
   *
   * `tokenPrefix` is NOT unique - two pair endpoints firing in the same
   * millisecond for the same user could (vanishingly rarely) mint tokens
   * with a colliding 16-char prefix. Returning the whole candidate set lets
   * the caller bcrypt-compare each one rather than relying on `findOne`
   * returning the document whose hash matches. Plaintext comparison happens
   * at the caller.
   */
  async findUnredeemedCandidatesByPrefix(tokenPrefix: string): Promise<ICcBridgePairingTokenDoc[]> {
    // Cap candidates so a malicious caller can't force an unbounded bcrypt-
    // compare loop if prefixes ever pile up under one user. In practice the
    // TTL keeps the active set to <=1; 16 is generous headroom.
    return CcBridgePairingToken.find({
      tokenPrefix,
      redeemedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
    })
      .limit(16)
      .lean();
  },

  /** Atomically mark a token redeemed; returns the record iff the burn succeeded. */
  async redeem(tokenId: string, deviceId: string): Promise<ICcBridgePairingTokenDoc | null> {
    return CcBridgePairingToken.findOneAndUpdate(
      { _id: tokenId, redeemedAt: { $exists: false } },
      { $set: { redeemedAt: new Date(), redeemedDeviceId: deviceId } },
      { new: true }
    ).lean();
  },
};
