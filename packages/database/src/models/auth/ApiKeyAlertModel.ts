import { IMongoDocument } from '@bike4mind/common';
import mongoose, { Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

export type ApiKeyAlertType = 'high_rate' | 'new_ip' | 'unusual_pattern';

export interface IApiKeyAlertDocument extends IMongoDocument {
  keyId: string;
  userId: string;
  alertType: ApiKeyAlertType;
  message: string;
  detectedAt: Date;
  resolvedAt?: Date;
  metadata: {
    currentRate?: number;
    baselineRate?: number;
    ipAddress?: string;
    endpoint?: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

const ApiKeyAlertSchema = new mongoose.Schema<IApiKeyAlertDocument>(
  {
    keyId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    alertType: { type: String, enum: ['high_rate', 'new_ip', 'unusual_pattern'], required: true },
    message: { type: String, required: true },
    detectedAt: { type: Date, required: true, default: () => new Date(), index: true },
    resolvedAt: { type: Date, index: true },
    metadata: {
      currentRate: { type: Number },
      baselineRate: { type: Number },
      ipAddress: { type: String },
      endpoint: { type: String },
    },
  },
  { timestamps: true }
);

// Add indexes for performance - user-scoped queries
ApiKeyAlertSchema.index({ userId: 1, keyId: 1, detectedAt: -1 });
ApiKeyAlertSchema.index({ userId: 1, resolvedAt: 1 }); // For active alerts (resolvedAt is null)
ApiKeyAlertSchema.index({ keyId: 1, resolvedAt: 1 });

export const ApiKeyAlert: Model<IApiKeyAlertDocument> =
  mongoose.models.ApiKeyAlert || mongoose.model<IApiKeyAlertDocument>('ApiKeyAlert', ApiKeyAlertSchema);

export class ApiKeyAlertRepository extends BaseRepository<IApiKeyAlertDocument> {
  constructor(model: Model<IApiKeyAlertDocument>) {
    super(model);
  }

  /**
   * Get active alerts for a specific user's API key
   */
  async findActiveByUserIdAndKeyId(userId: string, keyId: string): Promise<IApiKeyAlertDocument[]> {
    return this.model
      .find({
        userId,
        keyId,
        resolvedAt: null,
      })
      .sort({ detectedAt: -1 })
      .exec();
  }

  /**
   * Get all active alerts for a user (all their API keys)
   */
  async findActiveByUserId(userId: string): Promise<IApiKeyAlertDocument[]> {
    return this.model
      .find({
        userId,
        resolvedAt: null,
      })
      .sort({ detectedAt: -1 })
      .exec();
  }

  /**
   * Create a new alert
   */
  async createAlert(
    userId: string,
    keyId: string,
    alertType: ApiKeyAlertType,
    message: string,
    metadata: IApiKeyAlertDocument['metadata']
  ): Promise<IApiKeyAlertDocument> {
    // Check if there's already an active alert of this type for this key
    const existing = await this.model.findOne({
      userId,
      keyId,
      alertType,
      resolvedAt: null,
    });

    if (existing) {
      // Update existing alert instead of creating duplicate
      const updated = await this.model.findByIdAndUpdate(
        existing._id,
        {
          message,
          metadata,
          detectedAt: new Date(),
        },
        { new: true }
      );
      if (!updated) {
        throw new Error(`Failed to update alert ${existing._id}`);
      }
      return updated;
    }

    return this.model.create({
      userId,
      keyId,
      alertType,
      message,
      metadata,
      detectedAt: new Date(),
    });
  }

  /**
   * Resolve an alert
   */
  async resolveAlert(userId: string, alertId: string): Promise<IApiKeyAlertDocument | null> {
    return this.model.findOneAndUpdate(
      {
        _id: alertId,
        userId, // Ensure user can only resolve their own alerts
        resolvedAt: null,
      },
      {
        resolvedAt: new Date(),
      },
      { new: true }
    );
  }

  /**
   * Resolve all alerts for a specific key
   */
  async resolveAllByKeyId(userId: string, keyId: string): Promise<void> {
    await this.model.updateMany(
      {
        userId,
        keyId,
        resolvedAt: null,
      },
      {
        resolvedAt: new Date(),
      }
    );
  }
}

export const apiKeyAlertRepository = new ApiKeyAlertRepository(ApiKeyAlert);
