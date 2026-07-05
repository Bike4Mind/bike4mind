import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';
import { McpServerName } from './McpServerTypes';

/**
 * Supported capability types for external integrations
 */
export type QuestCapabilityType = 'github' | 'slack' | 'jira' | 'calendar' | 'cli';

/**
 * Sync direction for external links
 */
export type SyncDirection = 'push' | 'pull' | 'bidirectional';

/**
 * Status of external link sync
 */
export type ExternalLinkStatus = 'synced' | 'pending' | 'conflict' | 'error' | 'disconnected' | 'orphaned';

/**
 * GitHub-specific configuration for external links
 */
export interface GitHubLinkConfig {
  repository: string; // "owner/repo"
  issueNumber?: number;
  prNumber?: number;
}

/**
 * Slack-specific configuration for external links
 */
export interface SlackLinkConfig {
  channelId: string;
  threadTs?: string;
  workspaceId?: string;
}

/**
 * Jira-specific configuration for external links
 */
export interface JiraLinkConfig {
  projectKey: string;
  issueKey?: string;
  cloudId?: string;
}

/**
 * Calendar-specific configuration for external links
 */
export interface CalendarLinkConfig {
  calendarId: string;
  eventId?: string;
  provider: 'google' | 'microsoft' | 'caldav';
}

/**
 * CLI-specific configuration for external links
 */
export interface CliLinkConfig {
  sessionId: string;
  workingDirectory?: string;
}

/**
 * Union type for all capability configs
 */
export type QuestCapabilityConfig =
  | GitHubLinkConfig
  | SlackLinkConfig
  | JiraLinkConfig
  | CalendarLinkConfig
  | CliLinkConfig;

/**
 * Represents a capability/integration that a quest can use
 */
export interface QuestCapability {
  id: string;
  type: QuestCapabilityType;
  provider: McpServerName;
  config: QuestCapabilityConfig;
  syncEnabled: boolean;
  lastSyncedAt?: Date;
}

/**
 * Represents a link between a quest and an external system
 */
export interface QuestExternalLink {
  id: string;
  questPlanId: string;
  questId?: string; // Optional: specific sub-quest ID

  // User and organization context for authorization and org-level webhooks
  userId: string;
  organizationId?: string;

  capabilityType: QuestCapabilityType;

  // External system reference
  externalId: string; // GitHub issue number, Slack message ts, etc.
  externalUrl: string;

  // Sync configuration
  syncDirection: SyncDirection;
  status: ExternalLinkStatus;

  // Version tracking for conflict detection
  localVersion?: string; // Quest updatedAt timestamp
  remoteVersion?: string; // External system's updated_at
  lastSyncedAt?: Date;

  // GitHub-specific fields
  github?: GitHubLinkConfig;

  // Slack-specific fields
  slack?: SlackLinkConfig;

  // Jira-specific fields
  jira?: JiraLinkConfig;

  // Calendar-specific fields
  calendar?: CalendarLinkConfig;

  // CLI-specific fields
  cli?: CliLinkConfig;

  // Error tracking
  lastError?: {
    message: string;
    code?: string;
    timestamp: Date;
    retryCount: number;
  };

  // Audit trail
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
}

/**
 * Document type for MongoDB storage
 */
export interface IQuestExternalLinkDocument extends Omit<QuestExternalLink, 'id'>, IMongoDocument {}

/**
 * Repository interface for QuestExternalLink operations
 *
 * SECURITY: User-facing query methods require userId for IDOR protection.
 * System/webhook methods that need cross-user queries should use base repository methods.
 */
export interface IQuestExternalLinkRepository extends IBaseRepository<IQuestExternalLinkDocument> {
  /**
   * Find all external links for a quest plan (user-scoped)
   * @param questPlanId - The quest plan ID
   * @param userId - Required for IDOR protection
   */
  findByQuestPlanId(questPlanId: string, userId: string): Promise<IQuestExternalLinkDocument[]>;

  /**
   * Find all external links for a specific sub-quest (user-scoped)
   * @param questPlanId - The quest plan ID
   * @param questId - The sub-quest ID
   * @param userId - Required for IDOR protection
   */
  findByQuestId(questPlanId: string, questId: string, userId: string): Promise<IQuestExternalLinkDocument[]>;

  /**
   * Find by external reference (user-scoped)
   * @param capabilityType - The capability type (github, slack, etc.)
   * @param externalId - The external system's ID
   * @param userId - Required for IDOR protection
   */
  findByExternalId(
    capabilityType: QuestCapabilityType,
    externalId: string,
    userId: string
  ): Promise<IQuestExternalLinkDocument | null>;

  /**
   * Find GitHub link by repository and issue number (user-scoped)
   * @param repository - Repository in "owner/repo" format
   * @param issueNumber - GitHub issue number
   * @param userId - Required for IDOR protection
   */
  findByGitHubIssue(
    repository: string,
    issueNumber: number,
    userId: string
  ): Promise<IQuestExternalLinkDocument | null>;

  /**
   * Find all links with pending sync (system-wide, for background jobs)
   * Returns links across all users - use for sync workers only
   */
  findPendingSync(limit?: number): Promise<IQuestExternalLinkDocument[]>;

  /**
   * Find all links with errors for retry (system-wide, for background jobs)
   * Returns links across all users - use for error recovery workers only
   */
  findWithErrors(maxRetryCount?: number): Promise<IQuestExternalLinkDocument[]>;

  /**
   * Update sync status
   */
  updateSyncStatus(
    linkId: string,
    status: ExternalLinkStatus,
    versions?: { localVersion?: string; remoteVersion?: string }
  ): Promise<IQuestExternalLinkDocument | null>;

  /**
   * Record sync error
   */
  recordError(linkId: string, error: { message: string; code?: string }): Promise<IQuestExternalLinkDocument | null>;

  /**
   * Mark as synced with version info
   */
  markSynced(linkId: string, localVersion: string, remoteVersion: string): Promise<IQuestExternalLinkDocument | null>;
}

/**
 * Sync event types for EventBridge
 */
export interface GitHubSyncEvent {
  schemaVersion: '1.0';
  questPlanId: string;
  externalLinkId: string;
  triggeredBy: 'webhook' | 'sync' | 'manual';
}

export interface GitHubIssueStatusChangedEvent extends GitHubSyncEvent {
  issueNumber: number;
  repository: string;
  previousState: 'open' | 'closed';
  newState: 'open' | 'closed';
}

export interface GitHubSyncConflictEvent extends GitHubSyncEvent {
  conflictType: 'title' | 'body' | 'status' | 'multiple';
  localVersion: string;
  remoteVersion: string;
}

export interface GitHubSyncCompletedEvent extends GitHubSyncEvent {
  direction: SyncDirection;
  fieldsUpdated: string[];
}
