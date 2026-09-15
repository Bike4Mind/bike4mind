import {
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

  async upsertByChannelId(
    channelId: string,
    data: Partial<ISlackChannelConfig>
  ): Promise<ISlackChannelConfigDocument & IMongoDocument> {
    const result = await this.model.findOneAndUpdate(
      { channelId },
      { $set: { ...data, channelId } },
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
}

export const slackChannelConfigRepository = new SlackChannelConfigRepository(SlackChannelConfig);

export default SlackChannelConfig;
