import {
  IJiraWebhookDeliveryDocument,
  IJiraWebhookDeliveryRepository,
  IMongoDocument,
  JiraWebhookDeliveryStatus,
} from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * Jira webhook delivery audit trail schema.
 *
 * Records each webhook delivery attempt for debugging and compliance.
 * Uses TTL index for automatic cleanup (7-day retention).
 */
const JiraWebhookDeliverySchema = new Schema<IJiraWebhookDeliveryDocument>(
  {
    deliveryId: { type: String, required: true },
    webhookConfigId: { type: String, required: true },
    subscriptionId: { type: String },
    userId: { type: String, required: true },
    eventType: { type: String, required: true },
    projectKey: { type: String },
    issueKey: { type: String },
    issueSummary: { type: String },
    status: {
      type: String,
      enum: Object.values(JiraWebhookDeliveryStatus),
      required: true,
    },
    processingDurationMs: { type: Number },
    errorMessage: { type: String },
    correlationId: { type: String },
    retryCount: { type: Number, default: 0 },
    payload: { type: Schema.Types.Mixed },
    slackWebhookUrl: { type: String },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

// TTL index for automatic cleanup after 7 days
JiraWebhookDeliverySchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800, name: 'jira_delivery_ttl' });

// Unique compound index for deduplication per subscriber
JiraWebhookDeliverySchema.index(
  { deliveryId: 1, subscriptionId: 1 },
  { unique: true, sparse: true, name: 'jira_delivery_dedup' }
);

// Index for subscription history lookup
JiraWebhookDeliverySchema.index({ subscriptionId: 1, createdAt: -1 }, { name: 'jira_delivery_subscription_history' });

// Index for webhook config history lookup (admin view)
JiraWebhookDeliverySchema.index({ webhookConfigId: 1, createdAt: -1 }, { name: 'jira_delivery_config_history' });

// Index for finding deliveries by delivery ID (for checking duplicates)
JiraWebhookDeliverySchema.index({ deliveryId: 1 }, { name: 'jira_delivery_id' });

export interface IJiraWebhookDeliveryModel extends Model<IJiraWebhookDeliveryDocument & IMongoDocument> {}

export const JiraWebhookDelivery: IJiraWebhookDeliveryModel =
  mongoose.models.JiraWebhookDelivery ??
  model<IJiraWebhookDeliveryDocument>('JiraWebhookDelivery', JiraWebhookDeliverySchema);

class JiraWebhookDeliveryRepository
  extends BaseRepository<IJiraWebhookDeliveryDocument & IMongoDocument>
  implements IJiraWebhookDeliveryRepository
{
  /**
   * Find deliveries for a subscription (for history view)
   *
   * @param subscriptionId - The subscription ID
   * @param limit - Maximum number of deliveries to return (default: 50)
   * @returns Array of delivery documents, sorted by creation date descending
   */
  async findBySubscription(
    subscriptionId: string,
    limit: number = 50
  ): Promise<(IJiraWebhookDeliveryDocument & IMongoDocument)[]> {
    return this.model.find({ subscriptionId }).sort({ createdAt: -1 }).limit(limit).exec();
  }

  /**
   * Find deliveries for a webhook config (for admin view)
   *
   * @param webhookConfigId - The webhook config ID
   * @param limit - Maximum number of deliveries to return (default: 100)
   * @returns Array of delivery documents, sorted by creation date descending
   */
  async findByWebhookConfig(
    webhookConfigId: string,
    limit: number = 100
  ): Promise<(IJiraWebhookDeliveryDocument & IMongoDocument)[]> {
    return this.model.find({ webhookConfigId }).sort({ createdAt: -1 }).limit(limit).exec();
  }

  /**
   * Check if delivery already exists (for deduplication)
   *
   * @param deliveryId - The Jira delivery ID from X-Atlassian-Webhook-Identifier header
   * @returns Delivery document if found, null otherwise
   */
  async findByDeliveryId(deliveryId: string): Promise<(IJiraWebhookDeliveryDocument & IMongoDocument) | null> {
    return this.findOne({ deliveryId });
  }

  /**
   * Check if delivery exists for specific subscriber (per-subscriber dedup)
   *
   * @param deliveryId - The Jira delivery ID
   * @param subscriptionId - The subscription ID
   * @returns Delivery document if found, null otherwise
   */
  async findByDeliveryAndSubscription(
    deliveryId: string,
    subscriptionId: string
  ): Promise<(IJiraWebhookDeliveryDocument & IMongoDocument) | null> {
    return this.findOne({ deliveryId, subscriptionId });
  }
}

export const jiraWebhookDeliveryRepository = new JiraWebhookDeliveryRepository(JiraWebhookDelivery);

export default JiraWebhookDelivery;
