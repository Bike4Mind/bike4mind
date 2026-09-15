import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

/**
 * Organization-level Slack workspace connection.
 *
 * Allows org owners to self-service install the B4M Slack app into their workspace.
 * Reuses the system's existing Slack app credentials (from SlackDevWorkspace).
 * Only stores per-workspace data (bot token, team info).
 */
export interface IOrgSlackWorkspace {
  /** Organization ID this workspace belongs to */
  organizationId: string;

  /** Slack workspace (team) ID */
  slackTeamId: string;

  /** Slack workspace display name */
  slackTeamName?: string;

  /** Which Slack app was installed (references SlackDevWorkspace.slackAppId) */
  slackAppId: string;

  /** Bot OAuth token for this workspace */
  slackBotToken?: string;

  /** Bot user ID in this workspace */
  slackBotUserId?: string;

  /** Bot ID in this workspace */
  slackBotId?: string;

  /** Whether the integration is active */
  enabled: boolean;

  /** When the app was installed to this workspace */
  installedAt?: Date;

  /** User ID of the org owner who installed */
  installedBy: string;
}

export interface IOrgSlackWorkspaceDocument extends IOrgSlackWorkspace, IMongoDocument {}

/**
 * API response type - excludes sensitive token
 */
export interface IOrgSlackWorkspaceResponse {
  id: string;
  organizationId: string;
  slackTeamId: string;
  slackTeamName?: string;
  slackAppId: string;
  slackBotUserId?: string;
  enabled: boolean;
  installedAt?: Date;
  installedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IOrgSlackWorkspaceRepository extends IBaseRepository<IOrgSlackWorkspaceDocument> {
  /** Find workspace by organization ID */
  findByOrganizationId(organizationId: string): Promise<IOrgSlackWorkspaceDocument | null>;

  /** Find workspace by Slack team ID (enabled only) */
  findBySlackTeamId(slackTeamId: string): Promise<IOrgSlackWorkspaceDocument | null>;

  /** Find workspace by Slack team ID regardless of enabled status - for uniqueness checks */
  findBySlackTeamIdAny(slackTeamId: string): Promise<IOrgSlackWorkspaceDocument | null>;

  /** Find workspace by Slack team ID with bot token included */
  findBySlackTeamIdWithToken(slackTeamId: string): Promise<IOrgSlackWorkspaceDocument | null>;

  /** Find workspace by organization ID with bot token included */
  findByOrganizationIdWithToken(organizationId: string): Promise<IOrgSlackWorkspaceDocument | null>;
}
