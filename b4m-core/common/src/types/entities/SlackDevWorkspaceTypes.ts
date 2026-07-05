import { IBaseRepository, IMongoDocument } from '.';

/**
 * Slack Dev Workspace
 * Represents an OAuth-installed Slack workspace for multi-tenant support
 */
export interface ISlackDevWorkspace {
  /** Display name for the workspace (e.g., "Acme", "Globex") */
  name?: string;

  /** Slack team/workspace ID (unique identifier from Slack) - Optional for apps created via manifest */
  slackTeamId?: string;

  /** Slack app ID from OAuth response */
  slackAppId: string;

  /** Bot user ID from OAuth response - Set during OAuth installation */
  slackBotUserId?: string;

  /** Bot ID from OAuth response (used in Slack events) - Set during OAuth installation */
  slackBotId?: string;

  /** OAuth bot token for this workspace (TODO: Add field-level encryption) - Set during OAuth installation */
  slackBotToken?: string;

  /** Bot display name for this workspace - Set during OAuth installation */
  slackBotName?: string;

  /** Whether this workspace is currently active */
  isActive: boolean;

  /** When the OAuth installation was completed - Optional until OAuth is complete */
  installedAt?: Date;

  /** When the workspace record was last updated */
  updatedAt: Date;

  /** When the workspace record was created */
  createdAt: Date;

  /** OAuth Client ID (from manifest creation) */
  slackClientId?: string;

  /** OAuth Client Secret (from manifest creation) - Sensitive */
  slackClientSecret?: string;

  /** OAuth Signing Secret (from manifest creation) - Sensitive */
  slackOAuthSigningSecret?: string;

  /** OAuth Redirect URI (from manifest creation) */
  slackOAuthRedirectUri?: string;

  /** Verification Token (legacy, from manifest creation) - Sensitive */
  slackVerificationToken?: string;

  /** App Configuration Token for manifest management (apps.manifest.export/update) - Sensitive */
  appConfigurationToken?: string;

  /** Whether Slack Workflow Steps (custom functions) are enabled. Requires a paid Slack plan. Defaults to true. */
  enableWorkflowSteps?: boolean;
}

/**
 * Slack Dev Workspace Document
 * Extends ISlackDevWorkspace with MongoDB document properties
 */
export interface ISlackDevWorkspaceDocument extends ISlackDevWorkspace, IMongoDocument {}

/**
 * Slack Dev Workspace Repository
 * Defines available database operations for workspace management
 */
export interface ISlackDevWorkspaceRepository extends IBaseRepository<ISlackDevWorkspaceDocument> {
  /**
   * Find a workspace by Slack team ID
   * @param slackTeamId - The Slack team/workspace ID
   * @returns The workspace document or null if not found
   */
  findBySlackTeamId(slackTeamId: string): Promise<ISlackDevWorkspaceDocument | null>;

  /**
   * Find all active workspaces
   * @returns Array of active workspace documents
   */
  findAllActive(): Promise<ISlackDevWorkspaceDocument[]>;

  /**
   * Find a workspace by Slack team ID (including inactive)
   * Use this for reinstall checks where we need to find deactivated workspaces
   * @param slackTeamId - The Slack team/workspace ID
   * @returns The workspace document or null if not found
   */
  findBySlackTeamIdIncludingInactive(slackTeamId: string): Promise<ISlackDevWorkspaceDocument | null>;

  /**
   * Deactivate a workspace (soft delete)
   * @param id - The workspace document ID to deactivate
   * @returns The updated workspace document or null if not found
   */
  deactivate(id: string): Promise<ISlackDevWorkspaceDocument | null>;

  /**
   * Find a workspace by team ID and include the bot token
   * Use this when you need to make Slack API calls
   * @param slackTeamId - The Slack team/workspace ID
   * @returns The workspace document with token included, or null if not found
   */
  findBySlackTeamIdWithToken(slackTeamId: string): Promise<ISlackDevWorkspaceDocument | null>;

  /**
   * Find a workspace by Slack App ID
   * Used for apps created via manifest
   * @param slackAppId - The Slack app ID
   * @returns The workspace document or null if not found
   */
  findBySlackAppId(slackAppId: string): Promise<ISlackDevWorkspaceDocument | null>;

  /**
   * Find a workspace by Slack App ID and Team ID
   * Used for apps with known team ID during OAuth or event handling
   * @param slackAppId - The Slack app ID
   * @param slackTeamId - The Slack team/workspace ID
   * @returns The workspace document or null if not found
   */
  findBySlackAppIdAndTeamId(slackAppId: string, slackTeamId: string): Promise<ISlackDevWorkspaceDocument | null>;

  /**
   * Create or update workspace with OAuth credentials
   * Used when creating app via manifest
   * @param data - Workspace data including OAuth credentials
   * @returns The created or updated workspace document
   */
  createOrUpdateWithCredentials(data: {
    name: string;
    slackAppId: string;
    slackClientId: string;
    slackClientSecret: string;
    slackOAuthSigningSecret: string;
    slackOAuthRedirectUri: string;
    slackVerificationToken?: string;
    enableWorkflowSteps?: boolean;
  }): Promise<ISlackDevWorkspaceDocument>;

  /**
   * Find a workspace by ID and include the bot token
   * Use this when you need to make Slack API calls (e.g., channel export)
   * @param id - The MongoDB document ID
   * @returns The workspace document with token included, or null if not found
   */
  findByIdWithToken(id: string): Promise<ISlackDevWorkspaceDocument | null>;

  /**
   * Find a workspace by ID and include the app configuration token
   * Use this for manifest management operations (export, update)
   * @param id - The MongoDB document ID
   * @returns The workspace document with config token included, or null if not found
   */
  findByIdWithConfigToken(id: string): Promise<ISlackDevWorkspaceDocument | null>;

  /**
   * Store or update the app configuration token for a workspace
   * @param id - The MongoDB document ID
   * @param token - The app configuration token
   * @returns The updated workspace document or null if not found
   */
  storeConfigToken(id: string, token: string): Promise<ISlackDevWorkspaceDocument | null>;
}

/** A single field-level difference between a live Slack manifest and the expected template */
export interface ManifestDifference {
  field: string;
  expected: unknown;
  actual: unknown;
}
