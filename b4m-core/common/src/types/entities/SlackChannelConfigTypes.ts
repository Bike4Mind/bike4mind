import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';
import { IModelConfig } from './ModelConfigTypes';

/**
 * Per-channel AI model configuration for Slack.
 *
 * Allows admins to override the default model, temperature, and max tokens
 * for a specific Slack channel. This is the highest-priority level in
 * the resolution chain: channel -> agent -> org -> system fallback.
 *
 * Also carries the channel's default GitHub repository (owner + repo),
 * used when a user creates an issue from Slack without naming a repo.
 */
export interface ISlackChannelConfig extends IModelConfig {
  channelId: string;
  slackTeamId: string;
  configuredBy: string;
  githubOwner?: string;
  githubRepo?: string;
}

export interface ISlackChannelConfigDocument extends ISlackChannelConfig, IMongoDocument {}

export interface ISlackChannelConfigRepository extends IBaseRepository<ISlackChannelConfigDocument> {
  findByChannelId(channelId: string): Promise<ISlackChannelConfigDocument | null>;
  upsertByChannelId(channelId: string, data: Partial<ISlackChannelConfig>): Promise<ISlackChannelConfigDocument>;
  findBySlackTeamId(slackTeamId: string): Promise<ISlackChannelConfigDocument[]>;
  deleteByChannelId(channelId: string): Promise<boolean>;
}
