/**
 * GitHub Connection Audit Logger
 *
 * Provides structured audit logging for GitHub connection lifecycle events.
 * Used for compliance (SOC2) and security incident response.
 *
 * All connection mutations are logged with actor, timestamp, and changes.
 * Sensitive data (credentials, keys) is never logged.
 */

import { Logger } from '@bike4mind/observability';

/**
 * Audit event types for GitHub connection operations
 */
export type GitHubConnectionAuditEvent =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'key_rotated'
  | 'pat_rotated'
  | 'enabled_changed'
  | 'test_executed';

/**
 * Context for a GitHub connection audit log entry
 */
export interface GitHubConnectionAuditContext {
  /** The connection ID */
  connectionId: string;
  /** The organization ID */
  organizationId: string;
  /** The user ID who performed the action */
  actorUserId: string;
  /** Connection type (github_app or service_account) */
  connectionType?: 'github_app' | 'service_account';
}

/**
 * Changes to log (keys only, no sensitive values)
 */
export interface GitHubConnectionAuditChanges {
  /** Fields that were changed (without values for security) */
  changedFields?: string[];
  /** Previous enabled state */
  previousEnabled?: boolean;
  /** New enabled state */
  newEnabled?: boolean;
  /** Allowed repositories count changed */
  allowedReposCount?: number;
  /** Test result if applicable */
  testResult?: 'success' | 'failure';
  /** Error code if applicable */
  errorCode?: string;
}

/**
 * Full audit log entry
 */
export interface GitHubConnectionAuditEntry {
  event: GitHubConnectionAuditEvent;
  context: GitHubConnectionAuditContext;
  changes?: GitHubConnectionAuditChanges;
  timestamp: string;
}

// Singleton logger instance
const auditLogger = new Logger({ metadata: { component: 'GitHubConnectionAudit' } });

/**
 * Log a GitHub connection audit event
 *
 * @param event - The type of event
 * @param context - Context about the connection and actor
 * @param changes - Optional changes made (no sensitive data)
 */
export function logGitHubConnectionAudit(
  event: GitHubConnectionAuditEvent,
  context: GitHubConnectionAuditContext,
  changes?: GitHubConnectionAuditChanges
): void {
  const entry: GitHubConnectionAuditEntry = {
    event,
    context,
    changes,
    timestamp: new Date().toISOString(),
  };

  // Log with structured data for easy querying in CloudWatch/log aggregation
  auditLogger.info('[GITHUB-CONNECTION-AUDIT]', {
    auditEvent: event,
    connectionId: context.connectionId,
    organizationId: context.organizationId,
    actorUserId: context.actorUserId,
    connectionType: context.connectionType,
    ...changes,
    timestamp: entry.timestamp,
  });
}

/**
 * Log connection created event
 */
export function logConnectionCreated(context: GitHubConnectionAuditContext, allowedReposCount?: number): void {
  logGitHubConnectionAudit('created', context, { allowedReposCount });
}

/**
 * Log connection updated event
 */
export function logConnectionUpdated(
  context: GitHubConnectionAuditContext,
  changedFields: string[],
  changes?: Pick<GitHubConnectionAuditChanges, 'previousEnabled' | 'newEnabled' | 'allowedReposCount'>
): void {
  logGitHubConnectionAudit('updated', context, {
    changedFields,
    ...changes,
  });
}

/**
 * Log connection deleted event
 */
export function logConnectionDeleted(context: GitHubConnectionAuditContext): void {
  logGitHubConnectionAudit('deleted', context);
}

/**
 * Log private key rotated event (GitHub App)
 */
export function logKeyRotated(context: GitHubConnectionAuditContext): void {
  logGitHubConnectionAudit('key_rotated', context);
}

/**
 * Log PAT rotated event (Service Account)
 */
export function logPatRotated(context: GitHubConnectionAuditContext): void {
  logGitHubConnectionAudit('pat_rotated', context);
}

/**
 * Log enabled status changed event
 */
export function logEnabledChanged(
  context: GitHubConnectionAuditContext,
  previousEnabled: boolean,
  newEnabled: boolean
): void {
  logGitHubConnectionAudit('enabled_changed', context, {
    previousEnabled,
    newEnabled,
  });
}

/**
 * Log test connection executed event
 */
export function logTestExecuted(
  context: GitHubConnectionAuditContext,
  testResult: 'success' | 'failure',
  errorCode?: string
): void {
  logGitHubConnectionAudit('test_executed', context, {
    testResult,
    errorCode,
  });
}
