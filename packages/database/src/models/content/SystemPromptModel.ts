import { IAdminSystemPrompt, IAdminSystemPromptDocument, IAdminSystemPromptHistory } from '@bike4mind/common';
import mongoose, { Model, model, Schema } from 'mongoose';
import { softDeletePlugin } from '../../utils/mongo';
import BaseRepository from '@bike4mind/db-core';
import { systemPromptHistoryRepository } from './SystemPromptHistoryModel';

const SystemPromptModelSchema = new Schema<IAdminSystemPrompt, Model<IAdminSystemPromptDocument>, {}>(
  {
    // unique index with partialFilterExpression added below to coexist with softDeletePlugin
    promptId: { type: String, required: true },
    name: { type: String, required: true, index: true },
    description: { type: String, required: true, maxlength: 2000 },
    content: { type: String, required: true, maxlength: 50000 },
    category: { type: String, required: true, index: true },
    tags: [{ type: String, index: true }],
    variables: [{ type: String }],
    enabled: { type: Boolean, default: true, index: true },
    version: { type: Number, default: 1 },
    activeVersion: { type: Number }, // 0 = code default, 1+ = stored version, undefined = legacy
    usageCount: { type: Number, default: 0 },
    successCount: { type: Number, default: 0 },
    errorCount: { type: Number, default: 0 },
    lastUsedAt: { type: Date, default: null },
    createdBy: { type: String, required: true },
    lastUpdatedBy: { type: String, required: true },
    lastUpdatedByName: { type: String, required: true },
  },
  {
    timestamps: true,
    virtuals: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Unique index that excludes soft-deleted records (deletedAt exists only on soft-deleted docs)
SystemPromptModelSchema.index(
  { promptId: 1 },
  { unique: true, partialFilterExpression: { deletedAt: { $exists: false } } }
);

// Indexes for efficient queries
SystemPromptModelSchema.index({ enabled: 1, category: 1 });
SystemPromptModelSchema.index({ tags: 1, enabled: 1 });
SystemPromptModelSchema.index({ category: 1, name: 1 });

SystemPromptModelSchema.plugin(softDeletePlugin);

/**
 * Repository for SystemPrompt operations
 */
export class SystemPromptRepository extends BaseRepository<IAdminSystemPromptDocument> {
  constructor(private systemPromptModel: Model<IAdminSystemPromptDocument>) {
    super(systemPromptModel);
    this.systemPromptModel = systemPromptModel;
  }

  /**
   * Find prompt by promptId
   */
  async findByPromptId(promptId: string): Promise<IAdminSystemPrompt | null> {
    const result = await this.systemPromptModel.findOne({ promptId });
    return result?.toJSON() as IAdminSystemPrompt | null;
  }

  /**
   * Find all enabled prompts
   */
  async findAllEnabled(): Promise<IAdminSystemPrompt[]> {
    const results = await this.systemPromptModel.find({ enabled: true }).sort({ category: 1, name: 1 });
    return results.map(r => r.toJSON() as IAdminSystemPrompt);
  }

  /**
   * Find prompts by category
   */
  async findByCategory(category: string): Promise<IAdminSystemPrompt[]> {
    const results = await this.systemPromptModel.find({ category, enabled: true }).sort({ name: 1 });
    return results.map(r => r.toJSON() as IAdminSystemPrompt);
  }

  /**
   * Find prompts by tag
   */
  async findByTag(tag: string): Promise<IAdminSystemPrompt[]> {
    const results = await this.systemPromptModel.find({ tags: tag, enabled: true });
    return results.map(r => r.toJSON() as IAdminSystemPrompt);
  }

  /**
   * Increment usage count and track success/error
   */
  async incrementUsageCount(promptId: string, success: boolean): Promise<void> {
    const updateFields = success
      ? { $inc: { usageCount: 1, successCount: 1 }, $set: { lastUsedAt: new Date() } }
      : { $inc: { usageCount: 1, errorCount: 1 }, $set: { lastUsedAt: new Date() } };

    await this.systemPromptModel.updateOne({ promptId }, updateFields);
  }

  /**
   * Update prompt content and metadata
   * Saves the current version to history before updating
   */
  async updatePrompt(
    promptId: string,
    updates: {
      name?: string;
      description?: string;
      content?: string;
      category?: string;
      tags?: string[];
      variables?: string[];
    },
    updatedBy: string,
    updatedByName: string,
    changeReason?: string
  ): Promise<IAdminSystemPrompt | null> {
    // Get current version before updating (to save to history)
    const current = await this.findByPromptId(promptId);

    if (current) {
      // Save current version to history before updating
      await systemPromptHistoryRepository.saveVersion({
        promptId: current.promptId,
        version: current.version,
        content: current.content,
        name: current.name,
        description: current.description,
        category: current.category,
        tags: current.tags,
        variables: current.variables,
        changeReason,
        createdBy: updatedBy,
        createdByName: updatedByName,
      });
    }

    // Advance activeVersion if it was pointing at the current version
    const setFields: Record<string, unknown> = {
      ...updates,
      lastUpdatedBy: updatedBy,
      lastUpdatedByName: updatedByName,
    };
    if (current && current.activeVersion === current.version) {
      setFields.activeVersion = current.version + 1;
    }

    const updated = await this.systemPromptModel.findOneAndUpdate(
      { promptId },
      {
        $set: setFields,
        $inc: { version: 1 },
      },
      { new: true }
    );

    return updated?.toJSON() as IAdminSystemPrompt | null;
  }

  /**
   * Toggle enabled status
   */
  async toggleEnabled(promptId: string, enabled: boolean): Promise<IAdminSystemPrompt | null> {
    const updated = await this.systemPromptModel.findOneAndUpdate({ promptId }, { $set: { enabled } }, { new: true });

    return updated?.toJSON() as IAdminSystemPrompt | null;
  }

  /**
   * Create or update prompt (upsert)
   */
  async upsertPrompt(
    promptData: Omit<
      IAdminSystemPrompt,
      'version' | 'activeVersion' | 'usageCount' | 'successCount' | 'errorCount' | 'lastUsedAt'
    >
  ): Promise<IAdminSystemPrompt> {
    const existing = await this.findByPromptId(promptData.promptId);

    if (existing) {
      const updated = await this.updatePrompt(
        promptData.promptId,
        {
          name: promptData.name,
          description: promptData.description,
          content: promptData.content,
          category: promptData.category,
          tags: promptData.tags,
          variables: promptData.variables,
        },
        promptData.lastUpdatedBy,
        promptData.lastUpdatedByName
      );
      return updated!;
    } else {
      const result = await this.systemPromptModel.create({
        ...promptData,
        version: 1,
        activeVersion: 1,
        usageCount: 0,
        successCount: 0,
        errorCount: 0,
        lastUsedAt: null,
      });

      // Also save version 1 to history
      await systemPromptHistoryRepository.saveVersion({
        promptId: promptData.promptId,
        version: 1,
        content: promptData.content,
        name: promptData.name,
        description: promptData.description,
        category: promptData.category,
        tags: promptData.tags,
        variables: promptData.variables,
        changeReason: 'Initial version',
        createdBy: promptData.createdBy,
        createdByName: promptData.lastUpdatedByName,
      });

      return result.toJSON() as IAdminSystemPrompt;
    }
  }

  /**
   * Reset to default - deletes the DB override
   * Saves the current version to history first for audit trail
   */
  async resetToDefault(
    promptId: string,
    deletedBy: string,
    deletedByName: string
  ): Promise<{ deleted: boolean; historyPreserved: boolean }> {
    const current = await this.findByPromptId(promptId);

    if (!current) {
      return { deleted: false, historyPreserved: false };
    }

    // Save final version to history with "Reset to default" reason
    await systemPromptHistoryRepository.saveVersion({
      promptId: current.promptId,
      version: current.version,
      content: current.content,
      name: current.name,
      description: current.description,
      category: current.category,
      tags: current.tags,
      variables: current.variables,
      changeReason: 'Reset to default',
      createdBy: deletedBy,
      createdByName: deletedByName,
    });

    // Delete the DB override
    await this.systemPromptModel.deleteOne({ promptId });

    return { deleted: true, historyPreserved: true };
  }

  /**
   * Get version history for a prompt
   */
  async getVersionHistory(promptId: string) {
    return systemPromptHistoryRepository.getVersions(promptId);
  }

  /**
   * Get a specific version from history
   */
  async getHistoricalVersion(promptId: string, version: number) {
    return systemPromptHistoryRepository.getVersion(promptId, version);
  }

  /**
   * Switch active version (change which version the app uses)
   * Also updates the prompt's content field so the app always uses .content
   * @param targetVersion 0 = code default, 1+ = stored version
   */
  async switchVersion(
    promptId: string,
    targetVersion: number,
    updatedBy: string,
    updatedByName: string,
    codeDefaultContent?: string
  ): Promise<IAdminSystemPrompt | null> {
    let newContent: string | undefined;

    if (targetVersion === 0) {
      newContent = codeDefaultContent;
    } else {
      const historyVersion = await systemPromptHistoryRepository.getVersion(promptId, targetVersion);
      if (!historyVersion) {
        return null;
      }
      newContent = historyVersion.content;
    }

    const updateSet: Record<string, unknown> = {
      activeVersion: targetVersion,
      lastUpdatedBy: updatedBy,
      lastUpdatedByName: updatedByName,
    };

    if (newContent !== undefined) {
      updateSet.content = newContent;
    }

    const updated = await this.systemPromptModel.findOneAndUpdate({ promptId }, { $set: updateSet }, { new: true });

    return updated?.toJSON() as IAdminSystemPrompt | null;
  }

  /**
   * Save changes to a specific version (update in place)
   * Does NOT create a new version - overwrites the existing version
   */
  async saveToVersion(
    promptId: string,
    version: number,
    updates: {
      content: string;
      name?: string;
      description?: string;
      category?: string;
      tags?: string[];
      variables?: string[];
    },
    updatedBy: string,
    updatedByName: string
  ): Promise<IAdminSystemPromptHistory | null> {
    const updatedHistory = await systemPromptHistoryRepository.updateVersion(promptId, version, {
      ...updates,
      updatedBy,
      updatedByName,
    });

    // Also update the main SystemPrompt document's content if this is the active version
    const prompt = await this.findByPromptId(promptId);
    if (prompt && prompt.activeVersion === version) {
      await this.systemPromptModel.updateOne(
        { promptId },
        {
          $set: {
            content: updates.content,
            ...(updates.name && { name: updates.name }),
            ...(updates.description && { description: updates.description }),
            ...(updates.category && { category: updates.category }),
            ...(updates.tags && { tags: updates.tags }),
            ...(updates.variables && { variables: updates.variables }),
            lastUpdatedBy: updatedBy,
            lastUpdatedByName: updatedByName,
          },
        }
      );
    }

    return updatedHistory;
  }

  /**
   * Create a new version and optionally set it as active
   */
  async createNewVersion(
    promptId: string,
    versionData: {
      content: string;
      name: string;
      description: string;
      category: string;
      tags: string[];
      variables: string[];
    },
    createdBy: string,
    createdByName: string,
    setAsActive: boolean = true
  ): Promise<{ version: number; history: IAdminSystemPromptHistory }> {
    const latestVersion = await systemPromptHistoryRepository.getLatestVersionNumber(promptId);
    const newVersion = latestVersion + 1;

    const history = await systemPromptHistoryRepository.saveVersion({
      promptId,
      version: newVersion,
      content: versionData.content,
      name: versionData.name,
      description: versionData.description,
      category: versionData.category,
      tags: versionData.tags,
      variables: versionData.variables,
      changeReason: `Created version ${newVersion}`,
      createdBy,
      createdByName,
    });

    const updateData: Partial<IAdminSystemPrompt> = {
      version: newVersion,
      lastUpdatedBy: createdBy,
      lastUpdatedByName: createdByName,
    };

    if (setAsActive) {
      updateData.activeVersion = newVersion;
      updateData.content = versionData.content;
      updateData.name = versionData.name;
      updateData.description = versionData.description;
      updateData.category = versionData.category;
      updateData.tags = versionData.tags;
      updateData.variables = versionData.variables;
    }

    await this.systemPromptModel.updateOne({ promptId }, { $set: updateData });

    return { version: newVersion, history };
  }

  /**
   * Update only the activeVersion field (used for lazy migration of legacy prompts)
   */
  async updateActiveVersion(promptId: string, activeVersion: number): Promise<void> {
    await this.systemPromptModel.updateOne({ promptId }, { $set: { activeVersion } });
  }

  /**
   * Get the active content for a prompt
   * Returns content based on activeVersion (from history or code default)
   * @param activeVersion 0 = code default, 1+ = stored version
   */
  async getActiveContent(promptId: string, codeDefault?: { content: string }): Promise<string | null> {
    const prompt = await this.findByPromptId(promptId);

    if (!prompt) {
      return codeDefault?.content ?? null;
    }

    // 0 = code default
    if (prompt.activeVersion === 0) {
      return codeDefault?.content ?? null;
    }

    // Legacy prompts without activeVersion - use content directly
    if (prompt.activeVersion === undefined || prompt.activeVersion === null) {
      return prompt.content;
    }

    // Get content from the active version in history
    const versionContent = await systemPromptHistoryRepository.getVersion(promptId, prompt.activeVersion);
    return versionContent?.content ?? prompt.content;
  }
}

export const SystemPrompt: Model<IAdminSystemPromptDocument> =
  (mongoose.models.SystemPrompt as Model<IAdminSystemPromptDocument>) ??
  model<IAdminSystemPrompt, Model<IAdminSystemPromptDocument>>('SystemPrompt', SystemPromptModelSchema);

export default SystemPrompt;

export const systemPromptRepository = new SystemPromptRepository(SystemPrompt);
