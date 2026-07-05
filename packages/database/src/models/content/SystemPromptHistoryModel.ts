import { IAdminSystemPromptHistory, IAdminSystemPromptHistoryDocument } from '@bike4mind/common';
import mongoose, { Model, model, Schema } from 'mongoose';

const SystemPromptHistorySchema = new Schema<IAdminSystemPromptHistory, Model<IAdminSystemPromptHistoryDocument>>(
  {
    promptId: { type: String, required: true },
    version: { type: Number, required: true },
    content: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, required: true },
    category: { type: String, required: true },
    tags: [{ type: String }],
    variables: [{ type: String }],
    changeReason: { type: String },
    createdBy: { type: String, required: true },
    createdByName: { type: String, required: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    virtuals: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Compound index for efficient lookups
SystemPromptHistorySchema.index({ promptId: 1, version: -1 });
// Unique constraint: one entry per promptId + version
SystemPromptHistorySchema.index({ promptId: 1, version: 1 }, { unique: true });

/**
 * Repository for SystemPromptHistory operations
 */
export class SystemPromptHistoryRepository {
  constructor(private historyModel: Model<IAdminSystemPromptHistoryDocument>) {}

  /**
   * Save a version to history
   */
  async saveVersion(historyEntry: Omit<IAdminSystemPromptHistory, 'createdAt'>): Promise<IAdminSystemPromptHistory> {
    const result = await this.historyModel.create(historyEntry);
    return result.toJSON() as IAdminSystemPromptHistory;
  }

  /**
   * Get all versions for a prompt, sorted by version descending (newest first)
   */
  async getVersions(promptId: string): Promise<IAdminSystemPromptHistory[]> {
    const results = await this.historyModel.find({ promptId }).sort({ version: -1 });
    return results.map(r => r.toJSON() as IAdminSystemPromptHistory);
  }

  /**
   * Get a specific version
   */
  async getVersion(promptId: string, version: number): Promise<IAdminSystemPromptHistory | null> {
    const result = await this.historyModel.findOne({ promptId, version });
    return result?.toJSON() as IAdminSystemPromptHistory | null;
  }

  /**
   * Get the latest version number for a prompt
   */
  async getLatestVersionNumber(promptId: string): Promise<number> {
    const latest = await this.historyModel.findOne({ promptId }).sort({ version: -1 }).select('version');
    return latest?.version ?? 0;
  }

  /**
   * Check if any history exists for a prompt
   */
  async hasHistory(promptId: string): Promise<boolean> {
    const count = await this.historyModel.countDocuments({ promptId });
    return count > 0;
  }

  /**
   * Delete all history for a prompt (used when resetting to default)
   */
  async deleteAllForPrompt(promptId: string): Promise<number> {
    const result = await this.historyModel.deleteMany({ promptId });
    return result.deletedCount;
  }

  /**
   * Update a specific version in place (for "save as same version" functionality)
   */
  async updateVersion(
    promptId: string,
    version: number,
    updates: {
      content?: string;
      name?: string;
      description?: string;
      category?: string;
      tags?: string[];
      variables?: string[];
      changeReason?: string;
      updatedBy: string;
      updatedByName: string;
    }
  ): Promise<IAdminSystemPromptHistory | null> {
    const result = await this.historyModel.findOneAndUpdate(
      { promptId, version },
      {
        $set: {
          ...(updates.content !== undefined && { content: updates.content }),
          ...(updates.name !== undefined && { name: updates.name }),
          ...(updates.description !== undefined && { description: updates.description }),
          ...(updates.category !== undefined && { category: updates.category }),
          ...(updates.tags !== undefined && { tags: updates.tags }),
          ...(updates.variables !== undefined && { variables: updates.variables }),
          ...(updates.changeReason !== undefined && { changeReason: updates.changeReason }),
        },
      },
      { new: true }
    );
    return result?.toJSON() as IAdminSystemPromptHistory | null;
  }
}

export const SystemPromptHistory: Model<IAdminSystemPromptHistoryDocument> =
  (mongoose.models.SystemPromptHistory as Model<IAdminSystemPromptHistoryDocument>) ??
  model<IAdminSystemPromptHistory, Model<IAdminSystemPromptHistoryDocument>>(
    'SystemPromptHistory',
    SystemPromptHistorySchema
  );

export const systemPromptHistoryRepository = new SystemPromptHistoryRepository(SystemPromptHistory);

export default SystemPromptHistory;
