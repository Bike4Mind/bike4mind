import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

/**
 * Organization-level GitHub webhook configuration.
 *
 * Enables enterprise teams to share a single GitHub webhook across multiple users.
 * Admin configures the webhook at org level, team members subscribe to receive events.
 */
export interface IOrgWebhookConfig {
  /** Organization ID this webhook config belongs to */
  organizationId: string;

  /** Unique routing token for webhook URL path (not a header - GitHub doesn't support custom headers) */
  routingToken: string;

  /** HMAC secret for signature validation */
  secret: string;

  /** Repositories configured for this webhook (owner/repo format) */
  repos: string[];

  /** Event types to receive (e.g., 'push', 'pull_request', 'issues') */
  subscribedEvents: string[];

  /** User ID of admin who created this config */
  createdBy: string;

  /** Whether the webhook is active */
  enabled: boolean;

  /** ISO timestamp of last successful webhook delivery */
  lastDeliveryAt?: string;
}

export interface IOrgWebhookConfigDocument extends IOrgWebhookConfig, IMongoDocument {}

/**
 * API response type - masks the secret for security
 */
export interface IOrgWebhookConfigResponse extends Omit<IOrgWebhookConfigDocument, 'secret'> {
  /** Masked secret showing only last 4 characters (mutual exclusive with secret) */
  secretMasked?: string;
  /** Plain secret for one-time reveal on creation or explicit reveal (mutual exclusive with secretMasked) */
  secret?: string;
  /** Webhook URL to configure in GitHub */
  webhookUrl: string;
  /** Count of active subscribers (only on GET) */
  subscriberCount?: number;
}

/**
 * Request body for creating/updating org webhook config
 */
export interface IOrgWebhookConfigRequest {
  repos: string[];
  subscribedEvents: string[];
  enabled?: boolean;
}

export interface IOrgWebhookConfigRepository extends IBaseRepository<IOrgWebhookConfigDocument> {
  /** Find config by routing token (for webhook handler) */
  findByRoutingToken(routingToken: string): Promise<IOrgWebhookConfigDocument | null>;

  /** Find config by organization ID */
  findByOrganizationId(organizationId: string): Promise<IOrgWebhookConfigDocument | null>;
}
