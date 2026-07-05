import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

/**
 * Webhook delivery audit trail.
 *
 * Records each webhook delivery attempt for debugging and compliance.
 * Uses TTL index for automatic cleanup (7-day retention).
 */
export interface IWebhookDelivery {
  /** GitHub delivery ID (X-GitHub-Delivery header) */
  deliveryId: string;

  /** Organization ID this delivery belongs to */
  organizationId: string;

  /** Subscription ID that received this delivery (for fan-out tracking) */
  subscriptionId?: string;

  /** User ID who received this delivery */
  userId: string;

  /** GitHub event type (e.g., 'push', 'pull_request') */
  eventType: string;

  /** Repository full name (owner/repo) */
  repository: string;

  /** Delivery status */
  status: WebhookDeliveryStatus;

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

  /** Target URL for delivery (stored for replay) */
  targetUrl?: string;

  /**
   * Kind of delivery record this represents.
   *   - 'outbound_http'     - outbound HTTP webhook delivery; replayable via the DLQ endpoint
   *   - 'org_notification'  - org-webhook fan-out notification record (Slack DM, etc.);
   *                           NOT replayable via the DLQ endpoint (no stored payload/targetUrl
   *                           because the delivery is internal, not an outbound HTTP call).
   *
   * Defaults to 'outbound_http' for older records that pre-date this field.
   */
  deliveryKind?: 'outbound_http' | 'org_notification';
}

export enum WebhookDeliveryStatus {
  /** Successfully delivered and processed */
  Success = 'success',
  /** Delivery failed (may be retried) */
  Failed = 'failed',
  /** Skipped due to filter/deduplication */
  Skipped = 'skipped',
  /** Pending delivery (in queue) */
  Pending = 'pending',
}

export interface IWebhookDeliveryDocument extends IWebhookDelivery, IMongoDocument {}

/**
 * API response type for delivery history
 */
export interface IWebhookDeliveryResponse extends IWebhookDeliveryDocument {
  /** Human-readable time since delivery */
  timeAgo?: string;
}

export interface IWebhookDeliveryRepository extends IBaseRepository<IWebhookDeliveryDocument> {
  /** Find deliveries for a subscription (for history view) */
  findBySubscription(subscriptionId: string, limit?: number): Promise<IWebhookDeliveryDocument[]>;

  /** Find deliveries for an organization (for admin view) */
  findByOrganization(organizationId: string, limit?: number): Promise<IWebhookDeliveryDocument[]>;

  /** Check if delivery already exists (for deduplication) */
  findByDeliveryId(deliveryId: string): Promise<IWebhookDeliveryDocument | null>;

  /** Check if delivery exists for specific subscriber (per-subscriber dedup) */
  findByDeliveryAndSubscription(deliveryId: string, subscriptionId: string): Promise<IWebhookDeliveryDocument | null>;
}
