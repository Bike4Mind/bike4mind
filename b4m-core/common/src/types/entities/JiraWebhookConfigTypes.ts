import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

/**
 * Jira webhook event types supported by Jira Cloud REST API.
 *
 * @see https://developer.atlassian.com/cloud/jira/platform/webhooks/
 */
export type JiraWebhookEventType =
  | 'jira:issue_created'
  | 'jira:issue_updated'
  | 'jira:issue_deleted'
  | 'comment_created'
  | 'comment_updated'
  | 'comment_deleted'
  | 'issue_property_set'
  | 'issue_property_deleted'
  | 'worklog_created'
  | 'worklog_updated'
  | 'worklog_deleted'
  | 'attachment_created'
  | 'attachment_deleted'
  | 'issuelink_created'
  | 'issuelink_deleted'
  | 'project_created'
  | 'project_updated'
  | 'project_deleted'
  | 'sprint_created'
  | 'sprint_updated'
  | 'sprint_started'
  | 'sprint_closed'
  | 'sprint_deleted'
  | 'board_created'
  | 'board_updated'
  | 'board_deleted';

/**
 * Common Jira webhook events for Slack notifications.
 * Used as defaults in subscription event filter UI.
 * The actual events sent by Jira are configured in Jira Admin.
 */
export const COMMON_JIRA_WEBHOOK_EVENTS: JiraWebhookEventType[] = [
  'jira:issue_created',
  'jira:issue_updated',
  'comment_created',
  'comment_updated',
  'sprint_started',
  'sprint_closed',
];

/**
 * Jira priority levels for filtering.
 */
export type JiraPriorityLevel = 'Highest' | 'High' | 'Medium' | 'Low' | 'Lowest';

/**
 * Organization-level Jira webhook configuration.
 *
 * Enables teams to receive Jira events and route them to Slack channels.
 * Users manually create an admin webhook in Jira (Admin -> System -> Webhooks)
 * using the URL and secret generated here.
 *
 * Admin webhooks:
 * - Support HMAC signing (x-hub-signature)
 * - Don't expire (unlike REST API dynamic webhooks)
 * - Work with any HTTPS URL
 */
export interface IJiraWebhookConfig {
  /** Atlassian cloud ID this webhook belongs to */
  atlassianCloudId: string;

  /** Atlassian site URL (e.g., "https://mycompany.atlassian.net") */
  atlassianSiteUrl: string;

  /** Unique routing token for webhook URL path */
  routingToken: string;

  /** HMAC secret for signature validation (encrypted) */
  secret: string;

  /** Previous secret during rotation (encrypted). Both secrets are valid until expiry. */
  previousSecret?: string;

  /** ISO timestamp when the previous secret stops being accepted */
  previousSecretExpiresAt?: string;

  /** Event types to receive (informational - configured in Jira Admin) */
  events: JiraWebhookEventType[];

  /** User ID who created this config */
  createdBy: string;

  /** Whether the webhook is active */
  enabled: boolean;

  /** ISO timestamp of last successful webhook delivery */
  lastDeliveryAt?: string;
}

export interface IJiraWebhookConfigDocument extends IJiraWebhookConfig, IMongoDocument {}

/**
 * API response type - masks the secret for security
 */
export interface IJiraWebhookConfigResponse extends Omit<IJiraWebhookConfigDocument, 'secret' | 'previousSecret'> {
  /** Masked secret showing only last 4 characters */
  secretMasked?: string;
  /** Plain secret for one-time reveal on creation or rotation */
  secret?: string;
  /** Webhook URL to configure (our receiver endpoint) */
  webhookUrl: string;
  /** Count of active subscribers */
  subscriberCount?: number;
  /** Whether a secret rotation is in progress (previous secret still accepted) */
  isRotating?: boolean;
}

/**
 * Request body for creating/updating Jira webhook config
 */
export interface IJiraWebhookConfigRequest {
  events: JiraWebhookEventType[];
  enabled?: boolean;
  /** Set to true to rotate the webhook secret. Generates a new secret and keeps the old one valid for 24 hours. */
  rotateSecret?: boolean;
}

export interface IJiraWebhookConfigRepository extends IBaseRepository<IJiraWebhookConfigDocument> {
  /** Find config by routing token (for webhook handler) */
  findByRoutingToken(routingToken: string): Promise<IJiraWebhookConfigDocument | null>;

  /** Find config by Atlassian cloud ID */
  findByAtlassianCloudId(atlassianCloudId: string): Promise<IJiraWebhookConfigDocument | null>;

  /** Update last delivery timestamp */
  updateLastDelivery(id: string): Promise<void>;
}
