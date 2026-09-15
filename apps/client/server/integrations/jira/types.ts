/**
 * Jira Webhook Integration - Types
 *
 * Types for webhook processing, Slack delivery, and filter validation.
 */

import { JiraPriorityLevel } from '@bike4mind/common';

/**
 * Result of webhook processing.
 */
export interface WebhookProcessingResult {
  success: boolean;
  message: string;
  eventType?: string;
  deliveryId?: string;
  error?: string;
}

/**
 * Slack delivery result.
 */
export interface SlackDeliveryResult {
  success: boolean;
  statusCode?: number;
  error?: string;
}

/**
 * Subscription match result for fan-out.
 */
export interface SubscriptionMatch {
  subscriptionId: string;
  userId: string;
  slackWebhookUrl: string;
  name?: string;
}

/**
 * Jira issue extracted from webhook payload for filtering.
 */
export interface ExtractedIssueInfo {
  projectKey: string;
  issueKey: string;
  issueType: string;
  priority?: string;
  summary: string;
}

/**
 * Extract issue information from webhook payload for filtering.
 */
export function extractIssueInfo(payload: Record<string, unknown>): ExtractedIssueInfo | null {
  const issue = payload.issue as Record<string, unknown> | undefined;
  if (issue) {
    const fields = issue.fields as Record<string, unknown> | undefined;
    if (fields) {
      const project = fields.project as Record<string, unknown> | undefined;
      const issuetype = fields.issuetype as Record<string, unknown> | undefined;
      const priority = fields.priority as Record<string, unknown> | undefined;

      return {
        projectKey: (project?.key as string) || '',
        issueKey: (issue.key as string) || '',
        issueType: (issuetype?.name as string) || '',
        priority: priority?.name as string | undefined,
        summary: (fields.summary as string) || '',
      };
    }
  }

  return null;
}

/**
 * Check if an issue matches subscription filters.
 */
export function matchesFilters(
  issueInfo: ExtractedIssueInfo,
  filters: {
    projectFilter: string[];
    priorityFilter: string[];
    issueTypeFilter: string[];
  }
): boolean {
  const { projectFilter, priorityFilter, issueTypeFilter } = filters;

  // Project filter (empty = all projects)
  if (projectFilter.length > 0 && !projectFilter.includes(issueInfo.projectKey)) {
    return false;
  }

  // Priority filter (empty = all priorities)
  if (priorityFilter.length > 0 && issueInfo.priority && !priorityFilter.includes(issueInfo.priority)) {
    return false;
  }

  // Issue type filter (empty = all types)
  if (issueTypeFilter.length > 0 && !issueTypeFilter.includes(issueInfo.issueType)) {
    return false;
  }

  return true;
}

// Filter Validation

const MAX_FILTER_ENTRIES = 50;
const MAX_ISSUE_TYPE_LENGTH = 100;

/** Jira project keys: start with a letter, followed by uppercase letters/digits, 1-20 chars */
const PROJECT_KEY_REGEX = /^[A-Z][A-Z0-9]{0,19}$/;

const VALID_PRIORITIES: ReadonlySet<string> = new Set<string>([
  'Highest',
  'High',
  'Medium',
  'Low',
  'Lowest',
] satisfies JiraPriorityLevel[]);

/**
 * Validate subscription filter arrays.
 * Throws descriptive error message if validation fails, returns null if valid.
 */
export function validateFilters(filters: {
  projectFilter?: string[];
  priorityFilter?: string[];
  issueTypeFilter?: string[];
}): string | null {
  const { projectFilter, priorityFilter, issueTypeFilter } = filters;

  if (projectFilter && projectFilter.length > 0) {
    if (projectFilter.length > MAX_FILTER_ENTRIES) {
      return `projectFilter exceeds maximum of ${MAX_FILTER_ENTRIES} entries`;
    }
    for (const key of projectFilter) {
      if (typeof key !== 'string' || !PROJECT_KEY_REGEX.test(key)) {
        return `Invalid project key "${key}". Must be 1-20 uppercase letters/digits starting with a letter (e.g., "PROJ", "SCRUM")`;
      }
    }
  }

  if (priorityFilter && priorityFilter.length > 0) {
    if (priorityFilter.length > 5) {
      return 'priorityFilter exceeds maximum of 5 entries';
    }
    for (const priority of priorityFilter) {
      if (!VALID_PRIORITIES.has(priority)) {
        return `Invalid priority "${priority}". Must be one of: Highest, High, Medium, Low, Lowest`;
      }
    }
  }

  if (issueTypeFilter && issueTypeFilter.length > 0) {
    if (issueTypeFilter.length > MAX_FILTER_ENTRIES) {
      return `issueTypeFilter exceeds maximum of ${MAX_FILTER_ENTRIES} entries`;
    }
    for (const issueType of issueTypeFilter) {
      if (typeof issueType !== 'string' || issueType.length === 0) {
        return 'issueTypeFilter entries must be non-empty strings';
      }
      if (issueType.length > MAX_ISSUE_TYPE_LENGTH) {
        return `Issue type "${issueType.substring(0, 20)}..." exceeds maximum length of ${MAX_ISSUE_TYPE_LENGTH} characters`;
      }
    }
  }

  return null;
}
