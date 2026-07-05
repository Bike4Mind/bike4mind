import mongoose from 'mongoose';
import { softDeletePlugin } from '../../utils/mongo';
import { ApiKeyType, IApiKeyDocument, IApiKeyRepository } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

interface IApiKeyModel extends mongoose.Model<IApiKeyDocument> {}

class ApiKeyRepository extends BaseRepository<IApiKeyDocument> implements IApiKeyRepository {
  constructor(model: IApiKeyModel) {
    super(model);
  }

  createe(apiKey: Omit<IApiKeyDocument, 'id' | 'updatedAt' | 'createdAt'>) {
    return this.model.create(apiKey);
  }
  findByUserIdAndType(userId: string, type: ApiKeyType) {
    return this.model.findOne({ userId, type, isActive: true }).exec();
  }
  findByUserIdAndTypes(userId: string, types: ApiKeyType[]) {
    return this.model.find({ userId, type: { $in: types }, isActive: true }).exec();
  }
  findByIdAndUserId(id: string, userId: string) {
    return this.model.findOne({ _id: id, userId });
  }
  findByIdAndUserIdAndType(id: string, userId: string, type: ApiKeyType) {
    return this.model.findOne({ _id: id, userId, type });
  }
  async findAllByUserId(userId: string) {
    const result = await this.model.find({ userId });
    return result.map(doc => doc.toJSON());
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
