import { IMongoDocument, IBaseRepository } from '@bike4mind/common';
import mongoose, { Schema, model, Model } from 'mongoose';
import crypto from 'crypto';
import BaseRepository from '@bike4mind/db-core';

/**
 * Deterministic digest for the device code lookup key. The raw device code is
 * 64 bytes of CSPRNG output, so a plain SHA-256 is not brute-forceable and needs
 * no salt - unlike a low-entropy secret. Being deterministic, it can be indexed,
 * so a poll is an O(1) indexed lookup rather than a per-document bcrypt compare
 * (an unauthenticated CPU-DoS vector). Store this; never store the raw code.
 */
export function digestDeviceCode(deviceCode: string): string {
  return crypto.createHash('sha256').update(deviceCode).digest('hex');
}

export interface IDeviceAuthorizationDocument extends IMongoDocument {
  deviceCode: string; // SHA-256 digest of the raw device code (see digestDeviceCode)
  userCode: string; // Plain text: "WXYZ-1234"
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';
  userId: string | null;
  expiresAt: Date; // 10 minutes from creation
  approvedAt: Date | null;
  lastPolledAt: Date | null;
  ipAddress: string;
  userAgent: string;
  pollCount: number;
  verificationAttempts: number;
  createdAt: Date;
  updatedAt: Date;
}

const DeviceAuthorizationSchema = new Schema<IDeviceAuthorizationDocument>(
  {
    deviceCode: { type: String, required: true },
    userCode: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: ['pending', 'approved', 'denied', 'expired', 'consumed'],
      default: 'pending',
    },
    userId: { type: String, default: null },
    expiresAt: { type: Date, required: true },
    approvedAt: { type: Date, default: null },
    lastPolledAt: { type: Date, default: null },
    ipAddress: { type: String, required: true },
    userAgent: { type: String, required: true },
    pollCount: { type: Number, default: 0 },
    verificationAttempts: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

// Indexes
DeviceAuthorizationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL index
DeviceAuthorizationSchema.index({ status: 1, expiresAt: 1 });
DeviceAuthorizationSchema.index({ deviceCode: 1 }); // O(1) token-poll lookup

export type IDeviceAuthorizationModel = Model<IDeviceAuthorizationDocument>;

export const DeviceAuthorizationModel =
  (mongoose.models['DeviceAuthorization'] as unknown as IDeviceAuthorizationModel) ??
  model<IDeviceAuthorizationDocument>('DeviceAuthorization', DeviceAuthorizationSchema);

// Repository Interface
export interface IDeviceAuthorizationRepository extends IBaseRepository<IDeviceAuthorizationDocument> {
  findByUserCode(userCode: string): Promise<IDeviceAuthorizationDocument | null>;
  findByDeviceCode(deviceCode: string): Promise<IDeviceAuthorizationDocument | null>;
  findPendingAndUnexpired(): Promise<IDeviceAuthorizationDocument[]>;
}

// Repository Implementation
class DeviceAuthorizationRepository
  extends BaseRepository<IDeviceAuthorizationDocument>
  implements IDeviceAuthorizationRepository
{
  constructor(model: IDeviceAuthorizationModel) {
    super(model);
  }

  async findByUserCode(userCode: string): Promise<IDeviceAuthorizationDocument | null> {
    // Strip all non-alphanumeric characters, then reconstruct with hyphen
    // This makes the API format-agnostic (accepts "ABCD1234", "ABCD-1234", etc.)
    const cleaned = userCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const formatted = cleaned.slice(0, 4) + '-' + cleaned.slice(4);

    return this.findOne({
      userCode: formatted,
      status: 'pending',
      expiresAt: { $gt: new Date() },
    });
  }

  async findByDeviceCode(deviceCode: string): Promise<IDeviceAuthorizationDocument | null> {
    // O(1) indexed lookup by deterministic digest - no per-document bcrypt scan.
    return this.findOne({
      deviceCode: digestDeviceCode(deviceCode),
      status: { $in: ['pending', 'approved', 'denied'] },
      expiresAt: { $gt: new Date() },
    });
  }

  async findPendingAndUnexpired(): Promise<IDeviceAuthorizationDocument[]> {
    return this.find({
      status: { $in: ['pending', 'approved', 'denied'] },
      expiresAt: { $gt: new Date() },
    });
  }
}

export const deviceAuthorizationRepository = new DeviceAuthorizationRepository(DeviceAuthorizationModel);
