import mongoose from 'mongoose';
import { softDeletePlugin } from '../../utils/mongo';
import { ApiKeyType, IApiKeyDocument, IApiKeyRepository } from '@bike4mind/common';
import { decryptAtRest, encryptAtRest, isSecretsAtRestConfigured } from '@bike4mind/utils/security';
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
      throw new Error(
        'SECRET_ENCRYPTION_KEY is not configured, refusing to store a provider API key in plaintext. ' +
          'Set a 64-hex key on this stage (sst secret set SECRET_ENCRYPTION_KEY <value>), or set B4M_SELF_HOST=true to opt into plaintext.'
      );
    }
    const stored = await super.create({ ...data, apiKey: encryptAtRest(data.apiKey) });
    return { ...stored, apiKey: data.apiKey };
  }
  async findByUserIdAndType(userId: string, type: ApiKeyType) {
    // lean({ virtuals: true }) so the id virtual survives (mongoose-lean-virtuals only fires
    // with the flag - see packages/database/src/index.ts); callers spread the result.
    const doc = await this.model.findOne({ userId, type, isActive: true }).lean({ virtuals: true }).exec();
    return decryptApiKeyInPlace(doc as (IApiKeyDocument & { apiKey?: string }) | null);
  }
  async findByUserIdAndTypes(userId: string, types: ApiKeyType[]) {
    const result = await this.model
      .find({ userId, type: { $in: types }, isActive: true })
      .lean({ virtuals: true })
      .exec();
    return result.map(doc => decryptApiKeyInPlace(doc as IApiKeyDocument & { apiKey?: string }));
  }
  // Consumed only by deleteApiKey, whose result is returned in the DELETE response. Do NOT
  // decrypt here: that would put a live plaintext provider key in a browser payload (the delete
  // route strips apiKey regardless). Hydrated (not lean) so the id virtual survives.
  findByIdAndUserId(id: string, userId: string) {
    return this.model.findOne({ _id: id, userId });
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
