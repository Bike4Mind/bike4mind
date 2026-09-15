/**
 * Jira Cloud Webhook API Types
 *
 * @see https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-webhooks/
 *
 * Note: Jira Cloud webhooks have specific constraints:
 * - Webhooks are tied to the OAuth app that created them
 * - Webhooks expire after 30 days and need refreshing
 * - Maximum of 100 webhooks per OAuth app
 */

// Re-export entity types for convenience
export type {
  JiraWebhookEventType,
  JiraPriorityLevel,
  IJiraWebhookConfig,
  IJiraWebhookConfigDocument,
  IJiraWebhookConfigResponse,
  IJiraWebhookConfigRequest,
  IJiraWebhookConfigRepository,
} from '../../types/entities/JiraWebhookConfigTypes';

export { COMMON_JIRA_WEBHOOK_EVENTS } from '../../types/entities/JiraWebhookConfigTypes';

export type {
  SlackTargetConfig,
  IJiraWebhookSubscription,
  IJiraWebhookSubscriptionDocument,
  IJiraWebhookSubscriptionResponse,
  IJiraWebhookSubscriptionRequest,
  IJiraWebhookSubscriptionRepository,
} from '../../types/entities/JiraWebhookSubscriptionTypes';

export type {
  JiraWebhookDeliveryStatus,
  IJiraWebhookDelivery,
  IJiraWebhookDeliveryDocument,
  IJiraWebhookDeliveryResponse,
  IJiraWebhookDeliveryRepository,
} from '../../types/entities/JiraWebhookDeliveryTypes';

import { JiraWebhookEventType } from '../../types/entities/JiraWebhookConfigTypes';

/**
 * Jira webhook as returned by the API.
 */
export interface JiraWebhook {
  /** Unique webhook ID */
  id: number;

  /** Events this webhook subscribes to */
  events: JiraWebhookEventType[];

  /** JQL filter (only issues matching this JQL trigger the webhook) */
  jqlFilter?: string;

  /** ISO timestamp when the webhook expires */
  expirationDate: string;
}

/**
 * Response from listing webhooks.
 */
export interface JiraWebhookListResponse {
  /** Pagination start index */
  startAt: number;

  /** Maximum results per page */
  maxResults: number;

  /** Total number of webhooks */
  total: number;

  /** Whether this is the last page */
  isLast: boolean;

  /** Webhooks on this page */
  values: JiraWebhook[];
}

/**
 * Request body for registering a webhook.
 *
 * Note: Jira Cloud doesn't accept a custom URL - it constructs the URL from
 * the OAuth app's callback URL. We need to use a workaround.
 */
export interface JiraWebhookRegisterRequest {
  /** URL where Jira will send webhook events */
  url: string;

  /** Events to subscribe to */
  webhooks: Array<{
    /** JQL filter for this webhook */
    jqlFilter: string;

    /** Events to subscribe to */
    events: JiraWebhookEventType[];
  }>;
}

/**
 * Response from registering webhooks.
 *
 * Jira returns 200 OK even if individual webhook registrations fail.
 * Each result item has either `createdWebhookId` (success) or `errors` (failure).
 */
export interface JiraWebhookRegisterResponse {
  webhookRegistrationResult: Array<{
    /** Created webhook ID (present on success) */
    createdWebhookId?: number;
    /** Error messages (present on failure) */
    errors?: string[];
  }>;
}

/**
 * Request body for refreshing webhook expiration.
 */
export interface JiraWebhookRefreshRequest {
  /** Webhook IDs to refresh */
  webhookIds: number[];
}

/**
 * Response from refreshing webhooks.
 */
export interface JiraWebhookRefreshResponse {
  /** New expiration date for refreshed webhooks */
  expirationDate: string;
}

/**
 * Request body for deleting webhooks.
 */
export interface JiraWebhookDeleteRequest {
  /** Webhook IDs to delete */
  webhookIds: number[];
}

// ============================================================================
// Webhook Event Payload Types
// ============================================================================

/**
 * Common fields in all Jira webhook event payloads.
 */
export interface JiraWebhookEventBase {
  /** Timestamp when the event occurred */
  timestamp: number;

  /** The type of event */
  webhookEvent: JiraWebhookEventType;

  /** User who triggered the event */
  user?: {
    accountId: string;
    displayName: string;
    emailAddress?: string;
  };
}

/**
 * Issue-related webhook event payload.
 */
export interface JiraIssueWebhookEvent extends JiraWebhookEventBase {
  webhookEvent: 'jira:issue_created' | 'jira:issue_updated' | 'jira:issue_deleted';

  issue: {
    id: string;
    key: string;
    self: string;
    fields: {
      summary: string;
      description?: unknown;
      status: {
        name: string;
        id: string;
        statusCategory?: {
          key: string;
          name: string;
        };
      };
      issuetype: {
        name: string;
        id: string;
      };
      project: {
        key: string;
        name: string;
        id: string;
      };
      priority?: {
        name: string;
        id: string;
      };
      assignee?: {
        accountId: string;
        displayName: string;
        emailAddress?: string;
      };
      reporter?: {
        accountId: string;
        displayName: string;
        emailAddress?: string;
      };
      created: string;
      updated: string;
      labels?: string[];
      [key: string]: unknown;
    };
  };

  /** For update events, contains the changelog */
  changelog?: {
    id: string;
    items: Array<{
      field: string;
      fieldtype: string;
      fieldId?: string;
      from?: string;
      fromString?: string;
      to?: string;
      toString?: string;
    }>;
  };
}

/**
 * Comment-related webhook event payload.
 */
export interface JiraCommentWebhookEvent extends JiraWebhookEventBase {
  webhookEvent: 'comment_created' | 'comment_updated' | 'comment_deleted';

  issue: {
    id: string;
    key: string;
    self: string;
    fields: {
      summary: string;
      project: {
        key: string;
        name: string;
      };
      issuetype: {
        name: string;
      };
      priority?: {
        name: string;
      };
    };
  };

  comment: {
    id: string;
    self: string;
    body: unknown; // ADF format
    author: {
      accountId: string;
      displayName: string;
      emailAddress?: string;
    };
    created: string;
    updated: string;
  };
}

/**
 * Sprint-related webhook event payload.
 */
export interface JiraSprintWebhookEvent extends JiraWebhookEventBase {
  webhookEvent: 'sprint_created' | 'sprint_updated' | 'sprint_started' | 'sprint_closed' | 'sprint_deleted';

  sprint: {
    id: number;
    name: string;
    state: 'future' | 'active' | 'closed';
    startDate?: string;
    endDate?: string;
    completeDate?: string;
    goal?: string;
    originBoardId: number;
  };
}

/**
 * Union type for all webhook event payloads.
 */
export type JiraWebhookEventPayload = JiraIssueWebhookEvent | JiraCommentWebhookEvent | JiraSprintWebhookEvent;

/**
 * Type guard to check if payload is an issue event.
 * Validates both the event type string and the presence of required structural fields.
 */
export function isIssueWebhookEvent(
  payload: Record<string, unknown>
): payload is Record<string, unknown> & JiraIssueWebhookEvent {
  const event = payload.webhookEvent;
  if (typeof event !== 'string' || !event.startsWith('jira:issue_')) return false;

  const issue = payload.issue as Record<string, unknown> | undefined;
  if (!issue || typeof issue.key !== 'string') return false;

  const fields = issue.fields as Record<string, unknown> | undefined;
  if (!fields || typeof fields.summary !== 'string') return false;

  const status = fields.status as Record<string, unknown> | undefined;
  const issuetype = fields.issuetype as Record<string, unknown> | undefined;
  const project = fields.project as Record<string, unknown> | undefined;
  if (!status?.name || !issuetype?.name || !project?.key) return false;

  return true;
}

/**
 * Type guard to check if payload is a comment event.
 * Validates both the event type string and the presence of required structural fields.
 */
export function isCommentWebhookEvent(
  payload: Record<string, unknown>
): payload is Record<string, unknown> & JiraCommentWebhookEvent {
  const event = payload.webhookEvent;
  if (typeof event !== 'string' || !event.startsWith('comment_')) return false;

  const issue = payload.issue as Record<string, unknown> | undefined;
  if (!issue || typeof issue.key !== 'string') return false;

  const comment = payload.comment as Record<string, unknown> | undefined;
  if (!comment || typeof comment.id !== 'string') return false;

  const author = comment.author as Record<string, unknown> | undefined;
  if (!author || typeof author.displayName !== 'string') return false;

  return true;
}

/**
 * Type guard to check if payload is a sprint event.
 * Validates both the event type string and the presence of required structural fields.
 */
export function isSprintWebhookEvent(
  payload: Record<string, unknown>
): payload is Record<string, unknown> & JiraSprintWebhookEvent {
  const event = payload.webhookEvent;
  if (typeof event !== 'string' || !event.startsWith('sprint_')) return false;

  const sprint = payload.sprint as Record<string, unknown> | undefined;
  if (!sprint || typeof sprint.name !== 'string') return false;

  return true;
}

/**
 * Extract and validate the webhookEvent string from a raw payload.
 * Returns the event type string if valid, or null if missing/invalid.
 */
export function extractWebhookEventType(payload: Record<string, unknown>): string | null {
  const event = payload.webhookEvent;
  if (typeof event !== 'string' || event.length === 0) return null;
  return event;
}

// ============================================================================
// Formatted Response Types
// ============================================================================

/**
 * Formatted webhook for API responses.
 */
export interface FormattedJiraWebhook {
  id: number;
  events: JiraWebhookEventType[];
  jqlFilter?: string;
  expirationDate: string;
  daysUntilExpiry: number;
  isExpiringSoon: boolean; // true if < 7 days
}

/**
 * Formatted webhook list response.
 */
export interface FormattedJiraWebhookList {
  webhooks: FormattedJiraWebhook[];
  total: number;
  hasMore: boolean;
}
