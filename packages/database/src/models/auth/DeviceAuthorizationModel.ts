import { IMongoDocument, IBaseRepository } from '@bike4mind/common';
import mongoose, { Schema, model, Model } from 'mongoose';
import bcrypt from 'bcryptjs';
import BaseRepository from '@bike4mind/db-core';

export interface IDeviceAuthorizationDocument extends IMongoDocument {
  deviceCode: string; // Hashed with bcrypt
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
    // Get all pending/approved/denied authorizations that haven't expired
    const pending = await this.find({
      status: { $in: ['pending', 'approved', 'denied'] },
      expiresAt: { $gt: new Date() },
    });

    // Compare device code with each hashed device code
    for (const auth of pending) {
      const isMatch = await bcrypt.compare(deviceCode, auth.deviceCode);
      if (isMatch) {
        return auth;
      }
    }

    return null;
  }

  async findPendingAndUnexpired(): Promise<IDeviceAuthorizationDocument[]> {
    return this.find({
      status: { $in: ['pending', 'approved', 'denied'] },
      expiresAt: { $gt: new Date() },
    });
  }
}

export const deviceAuthorizationRepository = new DeviceAuthorizationRepository(DeviceAuthorizationModel);
