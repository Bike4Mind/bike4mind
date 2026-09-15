import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

/**
 * Webhook audit log status enum.
 * Tracks the lifecycle of a webhook delivery.
 */
export enum WebhookAuditStatus {
  /** Webhook received but not yet processed */
  Received = 'received',
  /** Webhook is currently being processed */
  Processing = 'processing',
  /** Webhook processing completed successfully */
  Completed = 'completed',
  /** Webhook processing failed */
  Failed = 'failed',
}

/**
 * Action taken in response to a webhook event.
 */
export interface IWebhookAuditAction {
  /** Type of action (e.g., 'slack_notification', 'ai_review', 'fan_out') */
  type: string;
  /** Status of the action */
  status: 'success' | 'failed';
  /** Additional details about the action */
  details?: Record<string, unknown>;
  /** Duration of the action in milliseconds */
  durationMs?: number;
}

/**
 * Error details for failed webhook processing.
 */
export interface IWebhookAuditError {
  /** Error message */
  message: string;
  /** Stack trace (if available) */
  stack?: string;
  /** Error code (if applicable) */
  code?: string;
}

/**
 * Metadata extracted from the GitHub webhook payload.
 * Key fields only - no full payload storage.
 */
export interface IWebhookAuditMetadata {
  /** PR number (for pull_request events) */
  prNumber?: number;
  /** Issue number (for issues events) */
  issueNumber?: number;
  /** GitHub event action (e.g., 'opened', 'closed', 'synchronize') */
  action?: string;
  /** Branch name (for push events) */
  branch?: string;
  /** Number of commits (for push events) */
  commitCount?: number;
}

/**
 * Webhook audit log entry.
 *
 * Records detailed information about each webhook delivery for debugging,
 * compliance, and operational visibility. Uses 90-day TTL for automatic cleanup.
 */
export interface IWebhookAuditLog {
  // Identity & Tracing
  /** GitHub delivery ID (X-GitHub-Delivery header) - unique per delivery */
  deliveryId: string;
  /** Correlation ID for distributed tracing */
  correlationId: string;

  // Event Details
  /** GitHub event type (X-GitHub-Event header) */
  event: string;
  /** Repository full name (owner/repo) */
  repository: string;
  /** GitHub user who triggered the event */
  sender: string;

  // Routing Context
  /** B4M organization ID (for org-level webhooks) */
  organizationId?: string;
  /** MCP server ID (for per-user webhooks) */
  mcpServerId?: string;

  // Timing
  /** When the webhook was received */
  receivedAt: Date;
  /** When processing completed */
  processedAt?: Date;
  /** Total processing duration in milliseconds */
  processingDurationMs?: number;

  // Status & Security
  /** Current status of the webhook delivery */
  status: WebhookAuditStatus;
  /** Whether HMAC signature was successfully verified */
  signatureVerified: boolean;

  // Error Tracking
  /** Error details if processing failed */
  error?: IWebhookAuditError;

  // Actions Taken
  /** List of actions taken in response to the webhook */
  actions: IWebhookAuditAction[];

  // GitHub Event Metadata
  /** Key metadata extracted from the webhook payload */
  metadata: IWebhookAuditMetadata;

  // TTL
  /** Expiration date for TTL index (receivedAt + 90 days) */
  expiresAt: Date;
}

export interface IWebhookAuditLogDocument extends IWebhookAuditLog, IMongoDocument {}

/** Source type for filtering webhooks by origin */
export type WebhookSourceType = 'org' | 'user';

export interface IWebhookAuditFilters {
  /** Filter by repository (owner/repo) */
  repository?: string;
  /** Filter by event type */
  event?: string;
  /** Filter by status */
  status?: WebhookAuditStatus;
  /** Filter by organization ID */
  organizationId?: string;
  /** Filter by MCP server ID */
  mcpServerId?: string;
  /** Filter by source type (org = organization webhooks, user = per-user MCP server webhooks) */
  sourceType?: WebhookSourceType;
  /** Start date for date range filter */
  startDate?: Date;
  /** End date for date range filter */
  endDate?: Date;
}

/**
 * Pagination options for list queries.
 */
export interface IWebhookAuditPaginationOptions {
  /** Maximum number of results to return */
  limit?: number;
  /** Cursor for pagination (base64 encoded timestamp) */
  cursor?: string;
}

/**
 * Paginated result for webhook audit log queries.
 */
export interface IWebhookAuditPaginatedResult {
  /** List of audit logs */
  logs: IWebhookAuditLogDocument[];
  /** Cursor for next page (null if no more results) */
  nextCursor: string | null;
  /** Whether there are more results */
  hasMore: boolean;
  /** Total count of matching records */
  total: number;
}

/**
 * Summary statistics for webhook audit logs.
 */
export interface IWebhookAuditSummary {
  /** Total number of deliveries */
  totalDeliveries: number;
  /** Number of successful deliveries */
  successCount: number;
  /** Number of failed deliveries */
  failureCount: number;
  /**
   * Success rate as a percentage (0-100).
   *
   * Returns `null` when a status filter is applied because the success rate
   * calculation requires comparing success count against total deliveries.
   * When filtering by status, the denominator (total) no longer represents
   * all deliveries, making the rate calculation meaningless.
   */
  successRate: number | null;
  /** Average processing duration in milliseconds */
  avgProcessingDurationMs: number;
  /** 95th percentile processing duration in milliseconds */
  p95ProcessingDurationMs: number;
  /** Breakdown by event type */
  eventBreakdown: Record<string, number>;
  /** Breakdown by status */
  statusBreakdown: Record<string, number>;
  /** Top error messages/codes */
  errorBreakdown: Record<string, number>;
  /** Hourly trend data */
  hourlyTrend: Array<{
    hour: string;
    count: number;
    /** Null when status filter is applied */
    successRate: number | null;
  }>;
}

/**
 * Repository interface for webhook audit logs.
 */
export interface IWebhookAuditLogRepository extends IBaseRepository<IWebhookAuditLogDocument> {
  /** Create a new audit log entry */
  createLog(data: Partial<IWebhookAuditLog>): Promise<IWebhookAuditLogDocument>;

  /** Update an existing audit log by delivery ID */
  updateByDeliveryId(deliveryId: string, update: Partial<IWebhookAuditLog>): Promise<IWebhookAuditLogDocument | null>;

  /** Find an audit log by delivery ID */
  findByDeliveryId(deliveryId: string): Promise<IWebhookAuditLogDocument | null>;

  /** Find audit logs with pagination and filtering */
  findByDateRange(
    startDate: Date,
    endDate: Date,
    filters?: IWebhookAuditFilters,
    options?: IWebhookAuditPaginationOptions
  ): Promise<IWebhookAuditPaginatedResult>;

  /** Get summary statistics */
  getAuditSummary(startDate: Date, endDate: Date, filters?: IWebhookAuditFilters): Promise<IWebhookAuditSummary>;

  /** Manual cleanup of old logs (backup for TTL) */
  cleanupOldLogs(olderThanDays: number): Promise<number>;
}
