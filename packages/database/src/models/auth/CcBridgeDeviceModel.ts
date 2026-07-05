import { ApiKeyStatus } from '@bike4mind/common';
import mongoose, { Model, Schema, model } from 'mongoose';
import { UserApiKey } from './UserApiKeyModel';

const ModelName = 'CcBridgeDevice';

/**
 * Durable record of a user's paired Claude Code bridge install.
 *
 * Created when a pairing token is redeemed; holds the `apiKeyId` of the
 * `UserApiKey` minted for this device so revoking a device == revoking
 * its key. One user can have many devices (laptop, desktop, CI runner...).
 */
export interface ICcBridgeDeviceDoc {
  _id: string;
  userId: string;
  /** Human-readable device label shown in settings UI. */
  deviceLabel: string;
  /** `_id` of the UserApiKey this device authenticates with. */
  apiKeyId: string;
  /** Platform string from the original download, e.g. `darwin-arm64`. */
  platform?: string;
  /** Bridge version that last connected from this device. */
  bridgeVersion?: string;
  /** Populated from the pairing token; source of truth for audit. */
  pairedAt: Date;
  lastSeenAt?: Date;
  /** Set when the user revokes access from the settings UI. */
  revokedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface ICcBridgeDeviceModel extends Model<ICcBridgeDeviceDoc> {}

const CcBridgeDeviceSchema = new Schema<ICcBridgeDeviceDoc>(
  {
    userId: { type: String, required: true },
    deviceLabel: { type: String, required: true },
    apiKeyId: { type: String, required: true },
    platform: { type: String },
    bridgeVersion: { type: String },
    pairedAt: { type: Date, required: true },
    lastSeenAt: { type: Date },
    revokedAt: { type: Date },
  },
  { timestamps: true }
);

CcBridgeDeviceSchema.index({ userId: 1, pairedAt: -1 });
CcBridgeDeviceSchema.index({ apiKeyId: 1 }, { unique: true });
// Active-devices-only index. Backs "list my paired devices" in settings
// without scanning revoked rows, which accumulate durably.
CcBridgeDeviceSchema.index(
  { userId: 1, lastSeenAt: -1 },
  { partialFilterExpression: { revokedAt: { $exists: false } }, name: 'userId_lastSeenAt_active' }
);

export const CcBridgeDevice: ICcBridgeDeviceModel =
  (mongoose.models[ModelName] as ICcBridgeDeviceModel) ||
  model<ICcBridgeDeviceDoc, ICcBridgeDeviceModel>(ModelName, CcBridgeDeviceSchema);

export const ccBridgeDeviceRepository = {
  async create(
    doc: Omit<ICcBridgeDeviceDoc, '_id' | 'createdAt' | 'updatedAt' | 'lastSeenAt' | 'revokedAt'>
  ): Promise<ICcBridgeDeviceDoc> {
    const created = await CcBridgeDevice.create(doc);
    return created.toObject();
  },

  async findByApiKeyId(apiKeyId: string): Promise<ICcBridgeDeviceDoc | null> {
    return CcBridgeDevice.findOne({ apiKeyId }).lean();
  },

  async listForUser(userId: string): Promise<ICcBridgeDeviceDoc[]> {
    return CcBridgeDevice.find({ userId }).sort({ pairedAt: -1 }).lean();
  },

  async touch(deviceId: string, bridgeVersion?: string): Promise<void> {
    await CcBridgeDevice.updateOne(
      { _id: deviceId },
      { $set: { lastSeenAt: new Date(), ...(bridgeVersion ? { bridgeVersion } : {}) } }
    );
  },

  /**
   * Mark the device revoked AND disable the `UserApiKey` it authenticates
   * with, so a leaked bridge key stops working for every endpoint - not
   * just the cc-bridge WS actions. The two writes are not transactional
   * on a standalone Mongo replica set; do the key disable first so an
   * interrupted revoke still kills authentication immediately.
   */
  async revoke(deviceId: string, userId: string): Promise<boolean> {
    const device = await CcBridgeDevice.findOne({
      _id: deviceId,
      userId,
      revokedAt: { $exists: false },
    }).lean();
    if (!device) return false;

    if (device.apiKeyId) {
      const keyUpdate = await UserApiKey.updateOne(
        { _id: device.apiKeyId, userId },
        { $set: { status: ApiKeyStatus.DISABLED } }
      );
      if (keyUpdate.modifiedCount > 0) {
        // Log each successful disable so a partial-replay revoke (key
        // disabled but device row not yet updated) stays visible in logs.
        console.info(`[CC_BRIDGE] Disabled apiKey ${device.apiKeyId} for user ${userId}, device ${deviceId}`);
      }
    }

    const res = await CcBridgeDevice.updateOne(
      { _id: deviceId, userId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } }
    );
    return res.modifiedCount > 0;
  },
};
