import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * A device the user has asked us to remember, so a fresh login from it is not
 * re-challenged for the second factor (TOTP) inside the trust window.
 *
 * The trust is a SERVER-SIDE record, not a claim the client asserts: the browser
 * holds an opaque `<deviceId>.<secret>` cookie and only the SHA-256 of the secret
 * is stored here, so a stolen database dump cannot mint a usable cookie and a
 * client cannot forge one. Nothing about the device (user agent, fingerprint) is
 * ever trusted for the decision - `label`/`userAgent` are display metadata only.
 *
 * Deliberately NOT keyed on the user's `tokenVersion`: /api/logout bumps that on
 * every normal logout, which would revoke the trust on the exact flow this feature
 * exists to smooth. Revocation is therefore explicit (see trustedDeviceRepository)
 * and wired into MFA disable / force-reset / admin session revoke.
 */

export interface ITrustedDevice {
  userId: string;
  /** SHA-256 (hex) of the cookie secret. The secret itself is never stored. */
  tokenHash: string;
  /** Human-readable device description shown in the management UI. */
  label: string;
  userAgent?: string;
  /** IP the trust was granted from; retained for the audit trail, not for validation. */
  createdIp?: string;
  lastUsedAt?: Date;
  lastUsedIp?: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface ITrustedDeviceDocument extends ITrustedDevice, Document {
  id: string;
}

const trustedDeviceSchema = new Schema<ITrustedDeviceDocument>(
  {
    userId: { type: String, required: true },
    tokenHash: { type: String, required: true, unique: true },
    label: { type: String, required: true },
    userAgent: { type: String },
    createdIp: { type: String },
    lastUsedAt: { type: Date },
    lastUsedIp: { type: String },
    createdAt: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

// Mongo reaps the document once the trust window closes, so an expired grant cannot
// linger as a usable record even if a lookup forgets its own expiry guard.
trustedDeviceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
trustedDeviceSchema.index({ userId: 1, createdAt: -1 });

const modelName = 'TrustedDevice';

export const TrustedDeviceModel: Model<ITrustedDeviceDocument> =
  mongoose.models[modelName] || mongoose.model<ITrustedDeviceDocument>(modelName, trustedDeviceSchema);

/** Trust window. 30 days matches what Google, Microsoft and Okta ship. */
export const TRUSTED_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Per-user cap, so a scripted client cannot grow the collection without bound. */
const MAX_TRUSTED_DEVICES_PER_USER = 20;

export class TrustedDeviceRepository {
  async create(input: {
    userId: string;
    tokenHash: string;
    label: string;
    userAgent?: string;
    createdIp?: string;
    expiresAt: Date;
  }): Promise<ITrustedDeviceDocument> {
    const created = await TrustedDeviceModel.create({ ...input, createdAt: new Date() });
    await this.pruneOldest(input.userId);
    return created;
  }

  /**
   * Look up a device by id, scoped to the owning user and to an unexpired window.
   * Both filters are part of the query (not a post-check) so a device belonging to
   * another account can never be returned to a caller that then only checks expiry.
   */
  async findValidForUser(id: string, userId: string): Promise<ITrustedDeviceDocument | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    return TrustedDeviceModel.findOne({ _id: id, userId, expiresAt: { $gt: new Date() } });
  }

  /**
   * Record a successful use. Deliberately does NOT move `expiresAt`: only a fresh
   * second-factor pass may move the window (see `extend`), so a device that merely keeps
   * skipping the challenge cannot renew itself indefinitely and always re-proves TOTP
   * once the 30 days from its last genuine grant run out.
   */
  async touch(id: string, ip?: string): Promise<void> {
    await TrustedDeviceModel.updateOne({ _id: id }, { $set: { lastUsedAt: new Date(), lastUsedIp: ip } });
  }

  /**
   * Re-grant: slide the window forward when the user opts in again on a known device.
   * Reachable only from /api/auth/mfa/verify, i.e. behind a fresh TOTP pass -- so the
   * window is anchored to the last proven second factor, never to mere use.
   */
  async extend(id: string, expiresAt: Date, ip?: string): Promise<void> {
    await TrustedDeviceModel.updateOne({ _id: id }, { $set: { lastUsedAt: new Date(), lastUsedIp: ip, expiresAt } });
  }

  async listByUser(userId: string): Promise<ITrustedDeviceDocument[]> {
    return TrustedDeviceModel.find({ userId, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
  }

  /** Returns true when a device was actually removed (false = unknown id or not this user's). */
  async revoke(id: string, userId: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;
    const result = await TrustedDeviceModel.deleteOne({ _id: id, userId });
    return result.deletedCount > 0;
  }

  /** Drop every trust for a user. Returns how many were removed. */
  async revokeAllForUser(userId: string): Promise<number> {
    const result = await TrustedDeviceModel.deleteMany({ userId });
    return result.deletedCount ?? 0;
  }

  private async pruneOldest(userId: string): Promise<void> {
    const excess = (await TrustedDeviceModel.countDocuments({ userId })) - MAX_TRUSTED_DEVICES_PER_USER;
    if (excess <= 0) return;
    const stale = await TrustedDeviceModel.find({ userId }).sort({ createdAt: 1 }).limit(excess).select('_id');
    await TrustedDeviceModel.deleteMany({ _id: { $in: stale.map((d: { _id: unknown }) => d._id) } });
  }
}

export const trustedDeviceRepository = new TrustedDeviceRepository();
