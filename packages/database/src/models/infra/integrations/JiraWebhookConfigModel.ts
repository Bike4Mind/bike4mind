import { IJiraWebhookConfigDocument, IJiraWebhookConfigRepository, IMongoDocument } from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * Organization-level Jira webhook configuration schema.
 *
 * Users manually create an admin webhook in Jira (Admin -> System -> Webhooks)
 * using the URL and secret generated here. Events are routed to Slack
 * via subscriptions.
 */
const JiraWebhookConfigSchema = new Schema<IJiraWebhookConfigDocument>(
  {
    atlassianCloudId: { type: String, required: true },
    atlassianSiteUrl: { type: String, required: true },
    routingToken: { type: String, required: true },
    secret: { type: String, required: true },
    previousSecret: { type: String },
    previousSecretExpiresAt: { type: String },
    events: { type: [String], default: [] },
    createdBy: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    lastDeliveryAt: { type: String },
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

// Index for webhook routing token lookups (used on every webhook delivery)
// Sparse index only includes documents where the field exists
JiraWebhookConfigSchema.index({ routingToken: 1 }, { unique: true, sparse: true, name: 'jira_webhook_routing_token' });

// Unique index to ensure one config per Atlassian cloud instance
JiraWebhookConfigSchema.index({ atlassianCloudId: 1 }, { unique: true, name: 'jira_webhook_cloud_id' });

export interface IJiraWebhookConfigModel extends Model<IJiraWebhookConfigDocument & IMongoDocument> {}

export const JiraWebhookConfig: IJiraWebhookConfigModel =
  mongoose.models.JiraWebhookConfig ?? model<IJiraWebhookConfigDocument>('JiraWebhookConfig', JiraWebhookConfigSchema);

class JiraWebhookConfigRepository
  extends BaseRepository<IJiraWebhookConfigDocument & IMongoDocument>
  implements IJiraWebhookConfigRepository
{
  /**
   * Find config by routing token (for webhook handler)
   *
   * @param routingToken - The routing token from URL path
   * @returns Config document if found, null otherwise
   */
  async findByRoutingToken(routingToken: string): Promise<(IJiraWebhookConfigDocument & IMongoDocument) | null> {
    return this.findOne({ routingToken });
  }

  /**
   * Find config by Atlassian cloud ID
   *
   * @param atlassianCloudId - The Atlassian cloud ID
   * @returns Config document if found, null otherwise
   */
  async findByAtlassianCloudId(
    atlassianCloudId: string
  ): Promise<(IJiraWebhookConfigDocument & IMongoDocument) | null> {
    return this.findOne({ atlassianCloudId });
  }

  /**
   * Update the lastDeliveryAt timestamp
   *
   * @param id - Config document ID
   */
  async updateLastDelivery(id: string): Promise<void> {
    await this.model.findByIdAndUpdate(id, { $set: { lastDeliveryAt: new Date().toISOString() } });
  }
}

export const jiraWebhookConfigRepository = new JiraWebhookConfigRepository(JiraWebhookConfig);

export default JiraWebhookConfig;
