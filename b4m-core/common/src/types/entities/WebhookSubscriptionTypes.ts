import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

/**
 * User subscription to organization-level GitHub webhooks.
 *
 * Enables individual users to receive webhook events from org-configured repositories.
 * Users explicitly opt-in by subscribing to specific repos within their organization.
 */
export interface IWebhookSubscription {
  /** User ID who owns this subscription */
  userId: string;

  /** Organization ID this subscription belongs to */
  organizationId: string;

  /** Subset of org repos user wants events for (must be subset of org config repos) */
  repos: string[];

  /** Event types to receive (subset of org config events, or empty for all) */
  events: string[];

  /** Optional: route events to specific MCP server (if user has multiple) */
  mcpServerId?: string;

  /** Whether this subscription is active */
  enabled: boolean;

  // Circuit breaker fields
  /** Count of consecutive delivery failures */
  consecutiveFailures?: number;

  /** When circuit breaker was opened (for cooldown tracking) */
  circuitBreakerOpenedAt?: Date | null;

  /** When subscription was auto-disabled due to circuit breaker */
  autoDisabledAt?: Date | null;

  /** Reason for auto-disable (e.g., "Exceeded 10 consecutive failures") */
  autoDisabledReason?: string | null;
}

export interface IWebhookSubscriptionDocument extends IWebhookSubscription, IMongoDocument {}

/**
 * API response type for subscription
 *
 * Note: organizationName and lastEventAt are computed/enrichment fields,
 * not stored in the database schema.
 */
export interface IWebhookSubscriptionResponse extends IWebhookSubscriptionDocument {
  /** Organization name for display (computed from org lookup) */
  organizationName?: string;
  /** ISO timestamp of last event received (computed from delivery records) */
  lastEventAt?: string;
}

/**
 * Request body for creating/updating subscription
 */
export interface IWebhookSubscriptionRequest {
  organizationId: string;
  repos: string[];
  events?: string[];
  mcpServerId?: string;
  enabled?: boolean;
}

export interface IWebhookSubscriptionRepository extends IBaseRepository<IWebhookSubscriptionDocument> {
  /** Find all subscriptions for a user */
  findByUserId(userId: string): Promise<IWebhookSubscriptionDocument[]>;

  /** Find all active subscriptions for an organization (for fan-out) */
  findActiveByOrganization(organizationId: string): Promise<IWebhookSubscriptionDocument[]>;

  /** Find subscriptions matching org and repo (for event delivery) */
  findByOrgAndRepo(organizationId: string, repo: string): Promise<IWebhookSubscriptionDocument[]>;

  /** Find subscription by user and org (unique constraint) */
  findByUserAndOrg(userId: string, organizationId: string): Promise<IWebhookSubscriptionDocument | null>;

  /** Delete all subscriptions for a user in an organization (for user removal cleanup) */
  deleteByUserAndOrg(userId: string, organizationId: string): Promise<void>;

  /** Count subscribers for an organization */
  countByOrganization(organizationId: string): Promise<number>;

  /** Delete all subscriptions for an organization (cascade delete) */
  deleteByOrganization(organizationId: string): Promise<number>;

  // Circuit breaker methods
  /**
   * Atomically increment consecutive failure count and check threshold.
   * Race-safe: Uses a single atomic operation to prevent TOCTOU race conditions.
   */
  incrementConsecutiveFailuresAtomic(
    subscriptionId: string,
    threshold: number,
    reason: string
  ): Promise<{ newFailureCount: number; wasAutoDisabled: boolean }>;

  /** Increment consecutive failure count for a subscription
   * @deprecated Use incrementConsecutiveFailuresAtomic for race-safe operations
   */
  incrementConsecutiveFailures(subscriptionId: string): Promise<number>;

  /** Reset consecutive failure count on successful delivery */
  resetConsecutiveFailures(subscriptionId: string): Promise<void>;

  /** Auto-disable subscription due to circuit breaker threshold
   * @deprecated Use incrementConsecutiveFailuresAtomic for race-safe operations
   */
  autoDisable(subscriptionId: string, reason: string): Promise<void>;

  /** Re-enable a previously auto-disabled subscription */
  reEnable(subscriptionId: string): Promise<void>;

  /** Find user IDs that have active subscriptions for the given org (batch check) */
  findActiveSubscriberUserIds(organizationId: string, userIds: string[]): Promise<string[]>;
}
