/**
 * Issue Tracker Abstraction Types
 *
 * Provides a common interface for creating and searching issues across
 * different issue trackers (GitHub, Jira, etc.)
 */

import type { Logger } from '@bike4mind/observability';

/**
 * Priority levels for issues
 */
export type IssuePriority = 'P0' | 'P1' | 'P2' | 'P3';

/**
 * Issue tracker types
 */
export type IssueTrackerType = 'github' | 'jira';

/**
 * Parameters for creating an issue
 */
export interface CreateIssueParams {
  title: string;
  body: string;
  priority: IssuePriority;
  labels: string[];
  fingerprint: string;
  isRegression?: boolean;
}

/**
 * Result from creating an issue
 */
export interface CreatedIssue {
  id: string;
  key: string; // GitHub: "owner/repo#123", Jira: "PROJ-123"
  url: string;
  title: string;
}

/**
 * Existing issue found during search
 */
export interface ExistingIssue {
  id: string;
  key: string;
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  fingerprint?: string | null;
  semanticFingerprint?: string | null;
  body?: string | null;
  createdAt: string;
  closedAt?: string;
  url: string;
}

/**
 * Health check result
 */
export interface HealthCheckResult {
  healthy: boolean;
  error?: string;
  details?: {
    connectionValid: boolean;
    projectAccessible: boolean;
    canCreateIssues: boolean;
  };
}

/**
 * Issue Tracker Service Interface
 *
 * All issue tracker implementations must implement this interface.
 * This allows the triage service to work with any supported issue tracker
 * without knowing the implementation details.
 */
export interface IssueTrackerService {
  /**
   * The type of issue tracker
   */
  readonly type: IssueTrackerType;

  /**
   * Create a new issue
   *
   * @param params Issue creation parameters
   * @returns Created issue details or null if creation failed
   */
  createIssue(params: CreateIssueParams): Promise<CreatedIssue | null>;

  /**
   * Search for existing open issues with the liveops label
   *
   * @returns Array of existing open issues
   */
  searchExistingIssues(): Promise<ExistingIssue[]>;

  /**
   * Fetch recently closed issues for regression detection
   *
   * @param lookbackDays Number of days to look back
   * @returns Array of recently closed issues
   */
  fetchRecentlyClosedIssues(lookbackDays: number): Promise<ExistingIssue[]>;

  /**
   * Check if the issue tracker connection is healthy
   *
   * @returns Health check result
   */
  checkHealth(): Promise<HealthCheckResult>;
}

/**
 * Logger type for issue tracker implementations
 * Uses the standard Logger from @bike4mind/utils
 */
export type IssueTrackerLogger = Logger;
