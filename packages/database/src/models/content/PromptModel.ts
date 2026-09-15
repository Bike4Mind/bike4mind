import mongoose, { Model, Schema, model } from 'mongoose';
import { IPromptDocument, IPromptRepository } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

export const PromptSchema = new Schema<IPromptDocument>(
  {
    type: { type: String, required: true },
    name: { type: String, required: true, unique: true },
    promptText: { type: String, required: true },
    tags: { type: [String] },
  },
  {
    timestamps: { createdAt: true, updatedAt: 'lastUpdated' },
    virtuals: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

export const Prompt: Model<IPromptDocument> = mongoose.models.Prompt ?? model<IPromptDocument>('Prompt', PromptSchema);
export default Prompt;

export class PromptRepository extends BaseRepository<IPromptDocument> implements IPromptRepository {
  async findAllByName(name: string): Promise<IPromptDocument[]> {
    return this.model.find({ name });
  }

  async findAllByType(type: string): Promise<IPromptDocument[]> {
    return this.model.find({ type });
  }

  async findAllWithTags(tags: string[]): Promise<IPromptDocument[]> {
    return this.model.find({ tags: { $in: tags } });
  }
}

export const promptRepository = new PromptRepository(Prompt);
