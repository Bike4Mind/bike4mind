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
 * used when a user creates an issue from Slack without naming a repo, and the
 * channel's opt-in for posting through the public API (`POST /api/v1/slack/messages`).
 */
export interface ISlackChannelConfig extends IModelConfig {
  channelId: string;
  slackTeamId: string;
  configuredBy: string;
  githubOwner?: string;
  githubRepo?: string;
  /**
   * Whether an API key with `slack:post` may post to this channel. Off unless an org owner turns it
   * on (`PUT /api/organizations/{id}/integrations/slack/channels`); absent on older documents, which
   * read as off.
   */
  apiPostEnabled?: boolean;
  /** When non-empty, only these API key ids may post here, even with `apiPostEnabled`. */
  apiPostAllowedKeyIds?: string[];
}

/** The API-posting opt-in fields an org owner sets on a channel. */
export interface ISlackChannelApiPostingUpdate {
  slackTeamId: string;
  apiPostEnabled: boolean;
  apiPostAllowedKeyIds: string[];
  /** B4M user id of the org owner who changed the setting; written only when the config is created. */
  configuredBy: string;
}

export interface ISlackChannelConfigDocument extends ISlackChannelConfig, IMongoDocument {}

export interface ISlackChannelConfigRepository extends IBaseRepository<ISlackChannelConfigDocument> {
  findByChannelId(channelId: string): Promise<ISlackChannelConfigDocument | null>;
  upsertByChannelId(channelId: string, data: Partial<ISlackChannelConfig>): Promise<ISlackChannelConfigDocument>;
  findBySlackTeamId(slackTeamId: string): Promise<ISlackChannelConfigDocument[]>;
  deleteByChannelId(channelId: string): Promise<boolean>;
  /**
   * Sets only the API-posting fields, creating the config when absent. Never moves an existing
   * config to another workspace: returns null when the channel's config belongs to a different
   * `slackTeamId`.
   */
  setApiPostingByChannelId(
    channelId: string,
    update: ISlackChannelApiPostingUpdate
  ): Promise<ISlackChannelConfigDocument | null>;
  findApiPostEnabledBySlackTeamId(slackTeamId: string): Promise<ISlackChannelConfigDocument[]>;
}
