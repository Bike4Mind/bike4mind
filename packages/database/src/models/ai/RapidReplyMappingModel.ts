import mongoose, { Document, Model, model, Schema } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import { RapidReplyResponseStyleCommon, RapidReplyResponseStylesCommon } from '@bike4mind/common';

export interface IRapidReplyMappingDocument extends Document {
  id: string;
  mainModelId: string;
  rapidModelId: string;
  enabled: boolean;
  priority: number;
  systemPrompt: string;
  maxTokens: number;
  responseStyle: RapidReplyResponseStyleCommon;
  maxLatency: number; // in milliseconds
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt?: Date;
  usageCount: number;
}

export interface IRapidReplyMappingRepository {
  findAll(): Promise<IRapidReplyMappingDocument[]>;
  findById(id: string): Promise<IRapidReplyMappingDocument | null>;
  findByMainModel(mainModelId: string): Promise<IRapidReplyMappingDocument | null>;
  findEnabled(): Promise<IRapidReplyMappingDocument[]>;
  createMapping(data: Partial<IRapidReplyMappingDocument>): Promise<IRapidReplyMappingDocument>;
  updateMapping(id: string, data: Partial<IRapidReplyMappingDocument>): Promise<IRapidReplyMappingDocument | null>;
  deleteMapping(id: string): Promise<boolean>;
  incrementUsageCount(id: string): Promise<IRapidReplyMappingDocument | null>;
  bulkUpdate(operations: Array<{ id: string; data: Partial<IRapidReplyMappingDocument> }>): Promise<boolean>;
}

const RapidReplyMappingSchema = new Schema<IRapidReplyMappingDocument>(
  {
    mainModelId: { type: String, required: true, unique: true },
    rapidModelId: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    priority: { type: Number, required: true, default: 1 },
    systemPrompt: { type: String, required: true },
    maxTokens: { type: Number, required: true, default: 150 },
    responseStyle: {
      type: String,
      enum: RapidReplyResponseStylesCommon,
      default: 'auto',
    },
    maxLatency: { type: Number, required: true, default: 2000 },
    createdBy: { type: String, required: true },
    lastUsedAt: { type: Date },
    usageCount: { type: Number, default: 0 },
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
// Note: mainModelId unique index is already created by the schema field definition
RapidReplyMappingSchema.index({ rapidModelId: 1 });
RapidReplyMappingSchema.index({ enabled: 1, priority: -1 });
RapidReplyMappingSchema.index({ lastUsedAt: -1 });

class RapidReplyMappingRepository
  extends BaseRepository<IRapidReplyMappingDocument>
  implements IRapidReplyMappingRepository
{
  constructor(model: Model<IRapidReplyMappingDocument>) {
    super(model);
  }

  async findAll(): Promise<IRapidReplyMappingDocument[]> {
    return this.model.find({}).sort({ priority: 1, createdAt: -1 });
  }

  async findById(id: string): Promise<IRapidReplyMappingDocument | null> {
    return this.model.findById(id);
  }

  async findByMainModel(mainModelId: string): Promise<IRapidReplyMappingDocument | null> {
    return this.model.findOne({ mainModelId, enabled: true });
  }

  async findEnabled(): Promise<IRapidReplyMappingDocument[]> {
    return this.model.find({ enabled: true }).sort({ priority: 1 });
  }

  async createMapping(data: Partial<IRapidReplyMappingDocument>): Promise<IRapidReplyMappingDocument> {
    const result = await this.model.create(data);
    return result.toJSON() as unknown as IRapidReplyMappingDocument;
  }

  async updateMapping(
    id: string,
    data: Partial<IRapidReplyMappingDocument>
  ): Promise<IRapidReplyMappingDocument | null> {
    const result = await this.model.findByIdAndUpdate(id, data, { new: true });
    return result?.toJSON() as unknown as IRapidReplyMappingDocument | null;
  }

  async deleteMapping(id: string): Promise<boolean> {
    const result = await this.model.findByIdAndDelete(id);
    return !!result;
  }

  async incrementUsageCount(id: string): Promise<IRapidReplyMappingDocument | null> {
    const result = await this.model.findByIdAndUpdate(
      id,
      {
        $inc: { usageCount: 1 },
        $set: { lastUsedAt: new Date() },
      },
      { new: true }
    );
    return result?.toJSON() as unknown as IRapidReplyMappingDocument | null;
  }

  async bulkUpdate(operations: Array<{ id: string; data: Partial<IRapidReplyMappingDocument> }>): Promise<boolean> {
    try {
      const bulkOps = operations.map(op => ({
        updateOne: {
          filter: { _id: op.id },
          update: { $set: op.data },
        },
      }));

      await this.model.bulkWrite(bulkOps);
      return true;
    } catch (error) {
      console.error('Bulk update failed:', error);
      return false;
    }
  }
}

export const RapidReplyMappingModel: Model<IRapidReplyMappingDocument> =
  (mongoose.models.RapidReplyMapping as Model<IRapidReplyMappingDocument>) ??
  model<IRapidReplyMappingDocument>('RapidReplyMapping', RapidReplyMappingSchema);

export const rapidReplyMappingRepository = new RapidReplyMappingRepository(RapidReplyMappingModel);
