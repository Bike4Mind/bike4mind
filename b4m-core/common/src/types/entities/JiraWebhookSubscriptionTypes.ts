import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';
import { JiraPriorityLevel } from './JiraWebhookConfigTypes';

/**
 * Slack target configuration for webhook notifications.
 *
 * Uses the workspace Slack bot to post messages via chat.postMessage.
 * - 'channel': Posts to a specific Slack channel by ID (e.g., "C0123456789")
 * - 'dm': Posts to the user's linked Slack account as a DM (fallback)
 */
export type SlackTargetConfig =
  | {
      type: 'channel';
      /** Slack channel ID (e.g., "C0123456789") */
      channelId: string;
    }
  | {
      type: 'dm';
    };

/**
 * User subscription to Jira webhook events.
 *
 * Enables individual users or teams to receive filtered Jira events in Slack.
 * Filters are applied on our receiver before sending to Slack (not by Jira).
 */
export interface IJiraWebhookSubscription {
  /** User ID who owns this subscription */
  userId: string;

  /** Reference to the JiraWebhookConfig document */
  webhookConfigId: string;

  /** Atlassian cloud ID (denormalized for efficient querying) */
  atlassianCloudId: string;

  /** Where to send Slack notifications */
  slackTarget: SlackTargetConfig;

  /** Filter by project keys (empty = all projects) */
  projectFilter: string[];

  /** Filter by priority levels (empty = all priorities) */
  priorityFilter: JiraPriorityLevel[];

  /** Filter by issue types (empty = all types, e.g., ["Bug", "Epic", "Story"]) */
  issueTypeFilter: string[];

  /** Optional: human-readable name for this subscription */
  name?: string;

  /** Whether this subscription is active */
  enabled: boolean;

  // Circuit breaker fields (same pattern as GitHub webhooks)
  /** Count of consecutive Slack delivery failures */
  consecutiveFailures?: number;

  /** When circuit breaker was opened (for cooldown tracking) */
  circuitBreakerOpenedAt?: Date | null;

  /** When subscription was auto-disabled due to circuit breaker */
  autoDisabledAt?: Date | null;

  /** Reason for auto-disable (e.g., "Exceeded 10 consecutive failures") */
  autoDisabledReason?: string | null;
}

export interface IJiraWebhookSubscriptionDocument extends IJiraWebhookSubscription, IMongoDocument {}

/**
 * API response type for subscription
 */
export interface IJiraWebhookSubscriptionResponse extends IJiraWebhookSubscriptionDocument {
  /** Atlassian site name for display */
  atlassianSiteName?: string;
  /** ISO timestamp of last event received */
  lastEventAt?: string;
}

/**
 * Request body for creating/updating subscription
 */
export interface IJiraWebhookSubscriptionRequest {
  webhookConfigId: string;
  slackTarget: SlackTargetConfig;
  projectFilter?: string[];
  priorityFilter?: JiraPriorityLevel[];
  issueTypeFilter?: string[];
  name?: string;
  enabled?: boolean;
}

export interface IJiraWebhookSubscriptionRepository extends IBaseRepository<IJiraWebhookSubscriptionDocument> {
  /** Find all subscriptions for a user */
  findByUserId(userId: string): Promise<IJiraWebhookSubscriptionDocument[]>;

  /** Find all active subscriptions for a webhook config (for fan-out) */
  findActiveByWebhookConfig(webhookConfigId: string): Promise<IJiraWebhookSubscriptionDocument[]>;

  /** Find subscription by user and webhook config (unique constraint) */
  findByUserAndConfig(userId: string, webhookConfigId: string): Promise<IJiraWebhookSubscriptionDocument | null>;

  /** Count subscribers for a webhook config */
  countByWebhookConfig(webhookConfigId: string): Promise<number>;

  /** Delete all subscriptions for a webhook config (cascade delete) */
  deleteByWebhookConfig(webhookConfigId: string): Promise<number>;

  // Circuit breaker methods (same pattern as GitHub)
  /**
   * Atomically increment consecutive failure count and check threshold.
   * Race-safe: Uses a single atomic operation to prevent TOCTOU race conditions.
   */
  incrementConsecutiveFailuresAtomic(
    subscriptionId: string,
    threshold: number,
    reason: string
  ): Promise<{ newFailureCount: number; wasAutoDisabled: boolean }>;

  /** Reset consecutive failure count on successful delivery */
  resetConsecutiveFailures(subscriptionId: string): Promise<void>;

  /** Re-enable a previously auto-disabled subscription */
  reEnable(subscriptionId: string): Promise<void>;
}
