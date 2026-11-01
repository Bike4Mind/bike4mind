import {
  ISlackChannelApiPostingUpdate,
  ISlackChannelConfig,
  ISlackChannelConfigDocument,
  ISlackChannelConfigRepository,
  IMongoDocument,
} from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * Per-channel AI model configuration for Slack.
 * Highest priority in the resolution chain: channel -> agent -> org -> system fallback.
 */
const SlackChannelConfigSchema = new Schema<ISlackChannelConfigDocument>(
  {
    channelId: { type: String, required: true },
    slackTeamId: { type: String, required: true },
    preferredModel: { type: String },
    temperature: { type: Number, min: 0, max: 2 },
    maxTokens: { type: Number, min: 1, max: 200000 },
    configuredBy: { type: String, required: true },
    githubOwner: { type: String },
    githubRepo: { type: String },
    apiPostEnabled: { type: Boolean, default: false },
    apiPostAllowedKeyIds: { type: [String], default: undefined },
    apiPostOrganizationId: { type: String },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// One config per channel
SlackChannelConfigSchema.index({ channelId: 1 }, { unique: true, name: 'slack_channel_config_channel_id' });

// Lookup by workspace
SlackChannelConfigSchema.index({ slackTeamId: 1 }, { name: 'slack_channel_config_team_id' });

export interface ISlackChannelConfigModel extends Model<ISlackChannelConfigDocument & IMongoDocument> {}

export const SlackChannelConfig: ISlackChannelConfigModel =
  mongoose.models.SlackChannelConfig ??
  model<ISlackChannelConfigDocument>('SlackChannelConfig', SlackChannelConfigSchema);

class SlackChannelConfigRepository
  extends BaseRepository<ISlackChannelConfigDocument & IMongoDocument>
  implements ISlackChannelConfigRepository
{
  async findByChannelId(channelId: string): Promise<(ISlackChannelConfigDocument & IMongoDocument) | null> {
    return this.findOne({ channelId });
  }

  /**
   * The model-config write (Slack App Home). It never sets the API-posting fields, and when it moves a
   * channel to another workspace (a shared channel configured from the other side) it first turns API
   * posting off, so an opt-in never travels with the channel to a team that did not grant it.
   */
  async upsertByChannelId(
    channelId: string,
    data: Partial<ISlackChannelConfig>
  ): Promise<ISlackChannelConfigDocument & IMongoDocument> {
    const { apiPostEnabled, apiPostAllowedKeyIds, apiPostOrganizationId, ...modelConfig } = data;
    if (modelConfig.slackTeamId) {
      await this.model.updateOne(
        { channelId, slackTeamId: { $ne: modelConfig.slackTeamId } },
        { $set: { apiPostEnabled: false, apiPostAllowedKeyIds: [] }, $unset: { apiPostOrganizationId: '' } }
      );
    }
    const result = await this.model.findOneAndUpdate(
      { channelId },
      { $set: { ...modelConfig, channelId } },
      { upsert: true, new: true }
    );
    return result as ISlackChannelConfigDocument & IMongoDocument;
  }

  async findBySlackTeamId(slackTeamId: string): Promise<(ISlackChannelConfigDocument & IMongoDocument)[]> {
    return this.model.find({ slackTeamId }).sort({ updatedAt: -1 });
  }

  async deleteByChannelId(channelId: string): Promise<boolean> {
    const result = await this.model.deleteOne({ channelId });
    return result.deletedCount > 0;
  }

  async removeModelConfigByChannelId(channelId: string, slackTeamId: string): Promise<boolean> {
    const deleted = await this.model.deleteOne({ channelId, slackTeamId, apiPostEnabled: { $ne: true } });
    if (deleted.deletedCount > 0) return true;
    const cleared = await this.model.updateOne(
      { channelId, slackTeamId, apiPostEnabled: true },
      {
        $unset: {
          preferredModel: '',
          preferredImageModel: '',
          temperature: '',
          maxTokens: '',
          githubOwner: '',
          githubRepo: '',
        },
      }
    );
    return cleared.matchedCount > 0;
  }

  async setApiPostingByChannelId(
    channelId: string,
    update: ISlackChannelApiPostingUpdate
  ): Promise<(ISlackChannelConfigDocument & IMongoDocument) | null> {
    const { slackTeamId, organizationId, apiPostEnabled, apiPostAllowedKeyIds, configuredBy } = update;
    try {
      // The filter pins slackTeamId, so a channel configured under another workspace misses it and the
      // upsert's insert then collides with the unique channelId index instead of re-homing that config.
      const result = await this.model.findOneAndUpdate(
        { channelId, slackTeamId },
        {
          $set: { apiPostEnabled, apiPostAllowedKeyIds, apiPostOrganizationId: organizationId },
          $setOnInsert: { channelId, slackTeamId, configuredBy },
        },
        { upsert: true, new: true }
      );
      return result as ISlackChannelConfigDocument & IMongoDocument;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) return null;
      throw error;
    }
  }

  async findApiPostEnabledBySlackTeamId(
    slackTeamId: string
  ): Promise<(ISlackChannelConfigDocument & IMongoDocument)[]> {
    return this.model.find({ slackTeamId, apiPostEnabled: true }).sort({ updatedAt: -1 });
  }

  async disableApiPostingByChannelId(channelId: string, slackTeamId: string) {
    return this.model.findOneAndUpdate(
      { channelId, slackTeamId, apiPostEnabled: true },
      { $set: { apiPostEnabled: false, apiPostAllowedKeyIds: [] }, $unset: { apiPostOrganizationId: '' } },
      { new: false }
    );
  }

  async clearApiPostingBySlackTeamId(slackTeamId: string, keepOrganizationId?: string): Promise<string[]> {
    const filter = {
      slackTeamId,
      apiPostEnabled: true,
      ...(keepOrganizationId && { apiPostOrganizationId: { $ne: keepOrganizationId } }),
    };
    const affected = await this.model.find(filter).select('channelId').lean();
    if (affected.length === 0) return [];
    await this.model.updateMany(filter, {
      $set: { apiPostEnabled: false, apiPostAllowedKeyIds: [] },
      $unset: { apiPostOrganizationId: '' },
    });
    return affected.map(config => config.channelId);
  }
}

export const slackChannelConfigRepository = new SlackChannelConfigRepository(SlackChannelConfig);

export default SlackChannelConfig;
