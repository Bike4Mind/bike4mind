import mongoose from 'mongoose';
import { softDeletePlugin } from '../../utils/mongo';
import { ApiKeyType, IApiKeyDocument, IApiKeyRepository } from '@bike4mind/common';
import { decryptAtRest, encryptAtRest, isSecretsAtRestConfigured } from '@bike4mind/utils';
import BaseRepository from '@bike4mind/db-core';

interface IApiKeyModel extends mongoose.Model<IApiKeyDocument> {}

/**
 * Per-user provider keys are stored encrypted at rest. Decrypt on read so callers
 * (apiKeyService.getApiKey / getEffective*) receive the usable plaintext key; a
 * not-yet-migrated plaintext value passes through unchanged. Mutates in place.
 */
function decryptApiKeyInPlace<T extends { apiKey?: string }>(doc: T): T;
function decryptApiKeyInPlace<T extends { apiKey?: string }>(doc: T | null): T | null;
function decryptApiKeyInPlace(doc: { apiKey?: string } | null) {
  if (doc && typeof doc.apiKey === 'string') {
    doc.apiKey = decryptAtRest(doc.apiKey);
  }
  return doc;
}

class ApiKeyRepository extends BaseRepository<IApiKeyDocument> implements IApiKeyRepository {
  constructor(model: IApiKeyModel) {
    super(model);
  }

  // Encrypt the provider key at rest on the way in (createApiKey stores through
  // BaseRepository.create). The returned object echoes the submitted plaintext rather
  // than the stored ciphertext, preserving the create response shape callers expect.
  //
  // Fail closed in a cloud stage: if no key is configured we must not silently persist a
  // provider key in plaintext. Only a deliberate self-host install (B4M_SELF_HOST) is allowed
  // to store plaintext, matching how the rest of the app degrades without SECRET_ENCRYPTION_KEY.
  async create(data: Omit<IApiKeyDocument, 'id' | 'updatedAt' | 'createdAt'>) {
    if (!isSecretsAtRestConfigured() && process.env.B4M_SELF_HOST !== 'true') {
      throw new Error('SECRET_ENCRYPTION_KEY is not configured - cannot store a provider API key');
    }
    const stored = await super.create({ ...data, apiKey: encryptAtRest(data.apiKey) });
    return { ...stored, apiKey: data.apiKey };
  }
  async findByUserIdAndType(userId: string, type: ApiKeyType) {
    const doc = await this.model.findOne({ userId, type, isActive: true }).lean().exec();
    return decryptApiKeyInPlace(doc as (IApiKeyDocument & { apiKey?: string }) | null);
  }
  async findByUserIdAndTypes(userId: string, types: ApiKeyType[]) {
    const result = await this.model
      .find({ userId, type: { $in: types }, isActive: true })
      .lean()
      .exec();
    return result.map(doc => decryptApiKeyInPlace(doc as IApiKeyDocument & { apiKey?: string }));
  }
  async findByIdAndUserId(id: string, userId: string) {
    const doc = await this.model.findOne({ _id: id, userId }).lean();
    return decryptApiKeyInPlace(doc as (IApiKeyDocument & { apiKey?: string }) | null);
  }
  // Returns a hydrated document (not lean) and does NOT decrypt: setApiKey mutates
  // isActive on the result and writes it straight back, so the stored apiKey must
  // stay ciphertext here or the write-back would persist plaintext over it.
  findByIdAndUserIdAndType(id: string, userId: string, type: ApiKeyType) {
    return this.model.findOne({ _id: id, userId, type });
  }
  async findAllByUserId(userId: string) {
    const result = await this.model.find({ userId });
    return result.map(doc => decryptApiKeyInPlace(doc.toJSON()));
  }
  updateAllByUserId(userId: string, value: Partial<IApiKeyDocument>) {
    return this.model.updateMany({ userId }, value);
  }
  updateAllByUserIdAndType(userId: string, type: ApiKeyType, value: Partial<IApiKeyDocument>) {
    return this.model.updateMany({ userId, type }, value);
  }
}

const ApiKeySchema = new mongoose.Schema<IApiKeyDocument, IApiKeyModel>(
  {
    userId: { type: String, required: true },
    apiKey: { type: String, required: true },
    type: { type: String, required: true },
    description: { type: String },
    isActive: { type: Boolean, required: true },
    expiresAt: { type: Date, required: true },
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

ApiKeySchema.plugin(softDeletePlugin);

export const ApiKey =
  (mongoose.models.ApiKey as IApiKeyModel) ?? mongoose.model<IApiKeyDocument, IApiKeyModel>('ApiKey', ApiKeySchema);

export const apiKeyRepository = new ApiKeyRepository(ApiKey);
