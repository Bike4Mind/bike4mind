import mongoose, { Document, Model, model, Schema } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import { softDeletePlugin } from '../../utils/mongo';

export interface IToolDefinitionOverrideDocument extends Document {
  id: string;
  // Identity
  toolId: string;
  toolName: string;

  // Content
  description: string;
  shortDescription: string;
  category: string;
  tags: string[];
  parameters: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };

  // Status
  enabled: boolean;
  version: number;

  // Analytics
  usageCount: number;
  successCount: number;
  errorCount: number;
  lastUsedAt: Date | null;

  // Audit Trail
  createdBy: string;
  lastUpdatedBy: string;
  lastUpdatedByName: string;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface IToolDefinitionOverrideRepository {
  findByToolId(toolId: string): Promise<IToolDefinitionOverrideDocument | null>;
  findAll(): Promise<IToolDefinitionOverrideDocument[]>;
  findAllEnabled(): Promise<IToolDefinitionOverrideDocument[]>;
  findByCategory(category: string): Promise<IToolDefinitionOverrideDocument[]>;
  updateDescription(
    toolId: string,
    description: string,
    shortDescription: string,
    enabled: boolean,
    updatedBy: string,
    updatedByName: string
  ): Promise<IToolDefinitionOverrideDocument | null>;
  createOverride(data: Partial<IToolDefinitionOverrideDocument>): Promise<IToolDefinitionOverrideDocument>;
  toggleEnabled(toolId: string, enabled: boolean): Promise<IToolDefinitionOverrideDocument | null>;
  incrementUsageCount(toolId: string, success: boolean): Promise<IToolDefinitionOverrideDocument | null>;
  softDelete(toolId: string): Promise<boolean>;
}

const ToolDefinitionOverrideSchema = new Schema<IToolDefinitionOverrideDocument>(
  {
    toolId: { type: String, required: true, unique: true },
    toolName: { type: String, required: true },
    description: { type: String, required: true, maxlength: 10000 },
    shortDescription: { type: String, required: true, maxlength: 500 },
    category: { type: String, required: true },
    tags: [{ type: String }],
    parameters: {
      type: { type: String, default: 'object' },
      properties: { type: Schema.Types.Mixed },
      required: [{ type: String }],
    },
    enabled: { type: Boolean, default: true },
    version: { type: Number, default: 1 },
    usageCount: { type: Number, default: 0 },
    successCount: { type: Number, default: 0 },
    errorCount: { type: Number, default: 0 },
    lastUsedAt: { type: Date, default: null },
    createdBy: { type: String, required: true },
    lastUpdatedBy: { type: String, required: true },
    lastUpdatedByName: { type: String, required: true },
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
ToolDefinitionOverrideSchema.index({ enabled: 1, category: 1 });
ToolDefinitionOverrideSchema.index({ tags: 1, enabled: 1 });
ToolDefinitionOverrideSchema.index({ toolName: 1 });
ToolDefinitionOverrideSchema.index({ category: 1 });

ToolDefinitionOverrideSchema.plugin(softDeletePlugin);

class ToolDefinitionOverrideRepository
  extends BaseRepository<IToolDefinitionOverrideDocument>
  implements IToolDefinitionOverrideRepository
{
  constructor() {
    super(ToolDefinitionOverrideModel);
  }

  async findByToolId(toolId: string): Promise<IToolDefinitionOverrideDocument | null> {
    const result = await this.model.findOne({ toolId });
    return result?.toJSON() as unknown as IToolDefinitionOverrideDocument | null;
  }

  async findAll(): Promise<IToolDefinitionOverrideDocument[]> {
    return this.model.find({}).sort({ category: 1, toolName: 1 });
  }

  async findAllEnabled(): Promise<IToolDefinitionOverrideDocument[]> {
    return this.model.find({ enabled: true }).sort({ category: 1, toolName: 1 });
  }

  async findByCategory(category: string): Promise<IToolDefinitionOverrideDocument[]> {
    return this.model.find({ category }).sort({ toolName: 1 });
  }

  async createOverride(data: Partial<IToolDefinitionOverrideDocument>): Promise<IToolDefinitionOverrideDocument> {
    const result = await this.model.create({
      ...data,
      version: 1,
      usageCount: 0,
      successCount: 0,
      errorCount: 0,
    });
    return result.toJSON() as unknown as IToolDefinitionOverrideDocument;
  }

  async updateDescription(
    toolId: string,
    description: string,
    shortDescription: string,
    enabled: boolean,
    updatedBy: string,
    updatedByName: string
  ): Promise<IToolDefinitionOverrideDocument | null> {
    const result = await this.model.findOneAndUpdate(
      { toolId },
      {
        $set: {
          description,
          shortDescription,
          enabled,
          lastUpdatedBy: updatedBy,
          lastUpdatedByName: updatedByName,
        },
        $inc: { version: 1 },
      },
      { new: true }
    );
    return result?.toJSON() as unknown as IToolDefinitionOverrideDocument | null;
  }

  async toggleEnabled(toolId: string, enabled: boolean): Promise<IToolDefinitionOverrideDocument | null> {
    const result = await this.model.findOneAndUpdate({ toolId }, { $set: { enabled } }, { new: true });
    return result?.toJSON() as unknown as IToolDefinitionOverrideDocument | null;
  }

  async incrementUsageCount(toolId: string, success: boolean): Promise<IToolDefinitionOverrideDocument | null> {
    const update: Record<string, unknown> = {
      $inc: { usageCount: 1 },
      $set: { lastUsedAt: new Date() },
    };

    if (success) {
      (update.$inc as Record<string, number>).successCount = 1;
    } else {
      (update.$inc as Record<string, number>).errorCount = 1;
    }

    const result = await this.model.findOneAndUpdate({ toolId }, update, { new: true });
    return result?.toJSON() as unknown as IToolDefinitionOverrideDocument | null;
  }

  async softDelete(toolId: string): Promise<boolean> {
    // Use the soft delete functionality from the plugin (sets deletedAt)
    const result = await this.model.deleteOne({ toolId });
    return (result as unknown as { deletedCount: number }).deletedCount > 0;
  }
}

export const ToolDefinitionOverrideModel: Model<IToolDefinitionOverrideDocument> =
  (mongoose.models.ToolDefinitionOverride as unknown as Model<IToolDefinitionOverrideDocument>) ??
  model<IToolDefinitionOverrideDocument>('ToolDefinitionOverride', ToolDefinitionOverrideSchema);

export const toolDefinitionOverrideRepository = new ToolDefinitionOverrideRepository();
