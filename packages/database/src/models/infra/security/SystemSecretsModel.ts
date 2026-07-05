import mongoose, { Document, Model, model, Schema } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import type { SystemSecretCategory, SystemSecretSource, ISystemSecret } from '@bike4mind/common';

// Re-export types for backward compatibility
export type { SystemSecretCategory, SystemSecretSource };

/**
 * System secret document interface extending the common interface.
 * Uses Omit to avoid conflicts with Mongoose Document's id property.
 *
 * NOTE: Tier 1 secrets (SECRET_ENCRYPTION_KEY, MONGODB_URI, SESSION_SECRET)
 * are NEVER stored in this collection - they remain in SST/AWS SSM only.
 */
export interface ISystemSecretDocument extends Omit<ISystemSecret, 'id'>, Document {
  id: string;
}

export interface ISystemSecretRepository {
  findBySecretName: (secretName: string) => Promise<ISystemSecretDocument | null>;
  findOverridableSecrets: () => Promise<ISystemSecretDocument[]>;
  findByCategory: (category: SystemSecretCategory) => Promise<ISystemSecretDocument[]>;
  findAll: () => Promise<ISystemSecretDocument[]>;
  upsertSecret: (secretName: string, data: Partial<ISystemSecretDocument>) => Promise<ISystemSecretDocument>;
  updateSecret: (id: string, data: Partial<ISystemSecretDocument>) => Promise<ISystemSecretDocument | null>;
  deleteSecret: (id: string) => Promise<boolean>;
}

const SystemSecretSchema = new Schema<ISystemSecretDocument>(
  {
    secretName: { type: String, required: true, unique: true },
    encryptedValue: { type: String, required: true },
    previousEncryptedValue: { type: String },
    keyVersion: { type: Number, required: true, default: 1 },
    category: {
      type: String,
      enum: ['auth', 'mail', 'oauth', 'api_key', 'slack'],
      required: true,
    },
    source: {
      type: String,
      enum: ['auto_generated', 'gui_configured', 'sst_migrated'],
      required: true,
    },
    isOverridable: { type: Boolean, required: true, default: true },
    description: { type: String },
    lastModifiedBy: { type: String },
    rotatedAt: { type: Date },
  },
  {
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
    timestamps: true,
    versionKey: false,
  }
);

// Indexes for performance
SystemSecretSchema.index({ category: 1 });
SystemSecretSchema.index({ isOverridable: 1 });
SystemSecretSchema.index({ source: 1 });

class SystemSecretRepository extends BaseRepository<ISystemSecretDocument> implements ISystemSecretRepository {
  constructor() {
    super(SystemSecretModel);
  }

  async findBySecretName(secretName: string): Promise<ISystemSecretDocument | null> {
    return this.model.findOne({ secretName });
  }

  async findOverridableSecrets(): Promise<ISystemSecretDocument[]> {
    return this.model.find({ isOverridable: true }).sort({ category: 1, secretName: 1 });
  }

  async findByCategory(category: SystemSecretCategory): Promise<ISystemSecretDocument[]> {
    return this.model.find({ category }).sort({ secretName: 1 });
  }

  async findAll(): Promise<ISystemSecretDocument[]> {
    return this.model.find({}).sort({ category: 1, secretName: 1 });
  }

  /**
   * Atomically upsert a secret using findOneAndUpdate with upsert.
   * Uses $setOnInsert for fields that should only be set on creation.
   * This prevents race conditions when multiple Lambda instances start simultaneously.
   */
  async upsertSecret(secretName: string, data: Partial<ISystemSecretDocument>): Promise<ISystemSecretDocument> {
    const { encryptedValue, keyVersion, category, source, isOverridable, description, lastModifiedBy } = data;

    const result = await this.model.findOneAndUpdate(
      { secretName },
      {
        $setOnInsert: {
          secretName,
          encryptedValue,
          keyVersion: keyVersion ?? 1,
          category,
          source,
          isOverridable: isOverridable ?? true,
          description,
          lastModifiedBy,
        },
      },
      {
        upsert: true,
        new: true,
        runValidators: true,
      }
    );

    return result.toJSON() as unknown as ISystemSecretDocument;
  }

  /**
   * Update an existing secret. Stores previous value for rollback.
   */
  async updateSecret(id: string, data: Partial<ISystemSecretDocument>): Promise<ISystemSecretDocument | null> {
    // If updating encryptedValue, first get the current value to store as previous
    if (data.encryptedValue) {
      const current = await this.model.findById(id);
      if (current) {
        data.previousEncryptedValue = current.encryptedValue;
        data.rotatedAt = new Date();
      }
    }

    const result = await this.model.findByIdAndUpdate(id, data, { new: true, runValidators: true });
    return result?.toJSON() as unknown as ISystemSecretDocument | null;
  }

  async deleteSecret(id: string): Promise<boolean> {
    const result = await this.model.findByIdAndDelete(id);
    return !!result;
  }
}

export const SystemSecretModel: Model<ISystemSecretDocument> =
  (mongoose.models.SystemSecret as unknown as Model<ISystemSecretDocument>) ??
  model<ISystemSecretDocument>('SystemSecret', SystemSecretSchema);

export const systemSecretRepository = new SystemSecretRepository();
