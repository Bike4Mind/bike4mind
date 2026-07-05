import mongoose, { Document, Model, model, Schema } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

export interface IRapidReplyPromptDocument extends Document {
  id: string;
  name: string;
  description?: string;
  content: string;
  modelPairIds: string[]; // Array of mapping IDs this prompt applies to
  domains: string[]; // e.g., ['general', 'technical', 'creative']
  isActive: boolean;
  version: number;
  parentId?: string; // For versioning
  parameters?: {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
  };
  variables?: Record<string, string>; // Template variables like {{tone}}, {{style}}
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  usageCount: number;
  successRate?: number; // Percentage of successful responses
}

export interface IRapidReplyPromptRepository {
  findAll(): Promise<IRapidReplyPromptDocument[]>;
  findById(id: string): Promise<IRapidReplyPromptDocument | null>;
  findActive(): Promise<IRapidReplyPromptDocument[]>;
  findByDomains(domains: string[]): Promise<IRapidReplyPromptDocument[]>;
  findByModelPair(modelPairId: string): Promise<IRapidReplyPromptDocument[]>;
  findVersions(parentId: string): Promise<IRapidReplyPromptDocument[]>;
  createPrompt(data: Partial<IRapidReplyPromptDocument>): Promise<IRapidReplyPromptDocument>;
  updatePrompt(id: string, data: Partial<IRapidReplyPromptDocument>): Promise<IRapidReplyPromptDocument | null>;
  deletePrompt(id: string): Promise<boolean>;
  createVersion(parentId: string, data: Partial<IRapidReplyPromptDocument>): Promise<IRapidReplyPromptDocument>;
  activateVersion(id: string): Promise<boolean>;
  incrementUsageCount(id: string): Promise<IRapidReplyPromptDocument | null>;
  updateSuccessRate(id: string, successRate: number): Promise<IRapidReplyPromptDocument | null>;
}

const RapidReplyPromptSchema = new Schema<IRapidReplyPromptDocument>(
  {
    name: { type: String, required: true },
    description: { type: String },
    content: { type: String, required: true },
    modelPairIds: [{ type: String }],
    domains: [{ type: String }],
    isActive: { type: Boolean, default: true },
    version: { type: Number, default: 1 },
    parentId: { type: String },
    parameters: {
      temperature: { type: Number },
      topP: { type: Number },
      maxTokens: { type: Number },
    },
    variables: { type: Map, of: String },
    createdBy: { type: String, required: true },
    usageCount: { type: Number, default: 0 },
    successRate: { type: Number },
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
RapidReplyPromptSchema.index({ modelPairIds: 1 });
RapidReplyPromptSchema.index({ domains: 1 });
RapidReplyPromptSchema.index({ isActive: 1, version: -1 });
RapidReplyPromptSchema.index({ parentId: 1 });
RapidReplyPromptSchema.index({ name: 1 });

class RapidReplyPromptRepository
  extends BaseRepository<IRapidReplyPromptDocument>
  implements IRapidReplyPromptRepository
{
  constructor() {
    super(RapidReplyPromptModel);
  }

  async findAll(): Promise<IRapidReplyPromptDocument[]> {
    return this.model.find({}).sort({ createdAt: -1 });
  }

  async findById(id: string): Promise<IRapidReplyPromptDocument | null> {
    return this.model.findById(id);
  }

  async findActive(): Promise<IRapidReplyPromptDocument[]> {
    return this.model.find({ isActive: true }).sort({ name: 1 });
  }

  async findByDomains(domains: string[]): Promise<IRapidReplyPromptDocument[]> {
    return this.model
      .find({
        domains: { $in: domains },
        isActive: true,
      })
      .sort({ usageCount: -1 });
  }

  async findByModelPair(modelPairId: string): Promise<IRapidReplyPromptDocument[]> {
    return this.model
      .find({
        modelPairIds: modelPairId,
        isActive: true,
      })
      .sort({ usageCount: -1 });
  }

  async findVersions(parentId: string): Promise<IRapidReplyPromptDocument[]> {
    return this.model.find({ parentId }).sort({ version: -1 });
  }

  async createPrompt(data: Partial<IRapidReplyPromptDocument>): Promise<IRapidReplyPromptDocument> {
    const result = await this.model.create(data);
    return result.toJSON() as unknown as IRapidReplyPromptDocument;
  }

  async updatePrompt(id: string, data: Partial<IRapidReplyPromptDocument>): Promise<IRapidReplyPromptDocument | null> {
    const result = await this.model.findByIdAndUpdate(id, data, { new: true });
    return result?.toJSON() as unknown as IRapidReplyPromptDocument | null;
  }

  async deletePrompt(id: string): Promise<boolean> {
    const result = await this.model.findByIdAndDelete(id);
    return !!result;
  }

  async createVersion(parentId: string, data: Partial<IRapidReplyPromptDocument>): Promise<IRapidReplyPromptDocument> {
    // Get the highest version number for this parent
    const latestVersion = await this.model.findOne({ parentId }).sort({ version: -1 }).select('version');

    const newVersion = (latestVersion?.version || 0) + 1;

    const versionData = {
      ...data,
      parentId,
      version: newVersion,
      isActive: false, // New versions start inactive
    };

    const result = await this.model.create(versionData);
    return result.toJSON() as unknown as IRapidReplyPromptDocument;
  }

  async activateVersion(id: string): Promise<boolean> {
    try {
      // First, deactivate all other versions in the same group
      const prompt = await this.model.findById(id);
      if (!prompt) return false;

      const groupId = prompt.parentId || prompt.id;

      await this.model.updateMany({ $or: [{ parentId: groupId }, { _id: groupId }] }, { isActive: false });

      // Then activate the selected version
      await this.model.findByIdAndUpdate(id, { isActive: true });
      return true;
    } catch (error) {
      console.error('Failed to activate version:', error);
      return false;
    }
  }

  async incrementUsageCount(id: string): Promise<IRapidReplyPromptDocument | null> {
    const result = await this.model.findByIdAndUpdate(id, { $inc: { usageCount: 1 } }, { new: true });
    return result?.toJSON() as unknown as IRapidReplyPromptDocument | null;
  }

  async updateSuccessRate(id: string, successRate: number): Promise<IRapidReplyPromptDocument | null> {
    const result = await this.model.findByIdAndUpdate(id, { successRate }, { new: true });
    return result?.toJSON() as unknown as IRapidReplyPromptDocument | null;
  }
}

export const RapidReplyPromptModel: Model<IRapidReplyPromptDocument> =
  (mongoose.models.RapidReplyPrompt as unknown as Model<IRapidReplyPromptDocument>) ??
  model<IRapidReplyPromptDocument>('RapidReplyPrompt', RapidReplyPromptSchema);

export const rapidReplyPromptRepository = new RapidReplyPromptRepository();
