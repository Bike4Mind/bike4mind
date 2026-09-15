import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

/**
 * Jira webhook delivery status.
 */
export enum JiraWebhookDeliveryStatus {
  /** Successfully delivered to Slack */
  Success = 'success',
  /** Delivery to Slack failed (may be retried) */
  Failed = 'failed',
  /** Skipped due to filter mismatch */
  Filtered = 'filtered',
  /** Pending delivery (in queue) */
  Pending = 'pending',
}

/**
 * Jira webhook delivery audit trail.
 *
 * Records each webhook delivery attempt for debugging and compliance.
 * Uses TTL index for automatic cleanup (7-day retention).
 */
export interface IJiraWebhookDelivery {
  /** Unique delivery ID from Jira (X-Atlassian-Webhook-Identifier header) */
  deliveryId: string;

  /** Webhook config ID this delivery belongs to */
  webhookConfigId: string;

  /** Subscription ID that received this delivery (for fan-out tracking) */
  subscriptionId?: string;

  /** User ID who received this delivery */
  userId: string;

  /** Jira event type (any event string from Jira, not limited to our known types) */
  eventType: string;

  /** Project key (e.g., "PROJ") */
  projectKey?: string;

  /** Issue key if applicable (e.g., "PROJ-123") */
  issueKey?: string;

  /** Issue summary for quick reference */
  issueSummary?: string;

  /** Delivery status */
  status: JiraWebhookDeliveryStatus;

  /** Processing duration in milliseconds */
  processingDurationMs?: number;

  /** Error message if delivery failed */
  errorMessage?: string;

  /** Correlation ID for distributed tracing */
  correlationId?: string;

  /** Number of retry attempts */
  retryCount?: number;

  /**
   * Original webhook payload (stored for DLQ replay).
   * Only stored for failed deliveries to enable retry functionality.
   */
  payload?: Record<string, unknown>;

  /** Slack webhook URL used for delivery (stored for replay) */
  slackWebhookUrl?: string;
}

export interface IJiraWebhookDeliveryDocument extends IJiraWebhookDelivery, IMongoDocument {}

/**
 * API response type for delivery history
 */
export interface IJiraWebhookDeliveryResponse extends IJiraWebhookDeliveryDocument {
  /** Human-readable time since delivery */
  timeAgo?: string;
}

export interface IJiraWebhookDeliveryRepository extends IBaseRepository<IJiraWebhookDeliveryDocument> {
  /** Find deliveries for a subscription (for history view) */
  findBySubscription(subscriptionId: string, limit?: number): Promise<IJiraWebhookDeliveryDocument[]>;

  /** Find deliveries for a webhook config (for admin view) */
  findByWebhookConfig(webhookConfigId: string, limit?: number): Promise<IJiraWebhookDeliveryDocument[]>;

  /** Check if delivery already exists (for deduplication) */
  findByDeliveryId(deliveryId: string): Promise<IJiraWebhookDeliveryDocument | null>;

  /** Check if delivery exists for specific subscriber (per-subscriber dedup) */
  findByDeliveryAndSubscription(
    deliveryId: string,
    subscriptionId: string
  ): Promise<IJiraWebhookDeliveryDocument | null>;
}
