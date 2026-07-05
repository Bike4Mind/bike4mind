import { IOrgWebhookConfigDocument, IOrgWebhookConfigRepository, IMongoDocument } from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * Organization-level GitHub webhook configuration schema.
 *
 * Enables enterprise teams to share a single GitHub webhook across multiple users.
 * Admin configures the webhook at org level, team members subscribe to receive events.
 */
const OrgWebhookConfigSchema = new Schema<IOrgWebhookConfigDocument>(
  {
    organizationId: { type: String, required: true },
    routingToken: { type: String, required: true },
    secret: { type: String, required: true },
    repos: { type: [String], default: [] },
    subscribedEvents: { type: [String], default: [] },
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
OrgWebhookConfigSchema.index({ routingToken: 1 }, { unique: true, sparse: true, name: 'org_webhook_routing_token' });

// Unique index to ensure one config per organization
OrgWebhookConfigSchema.index({ organizationId: 1 }, { unique: true, name: 'org_webhook_org_id' });

export interface IOrgWebhookConfigModel extends Model<IOrgWebhookConfigDocument & IMongoDocument> {}

export const OrgWebhookConfig: IOrgWebhookConfigModel =
  mongoose.models.OrgWebhookConfig ?? model<IOrgWebhookConfigDocument>('OrgWebhookConfig', OrgWebhookConfigSchema);

class OrgWebhookConfigRepository
  extends BaseRepository<IOrgWebhookConfigDocument & IMongoDocument>
  implements IOrgWebhookConfigRepository
{
  /**
   * Find config by routing token (for webhook handler)
   *
   * @param routingToken - The routing token from URL path
   * @returns Config document if found, null otherwise
   */
  async findByRoutingToken(routingToken: string): Promise<(IOrgWebhookConfigDocument & IMongoDocument) | null> {
    return this.findOne({ routingToken });
  }

  /**
   * Find config by organization ID
   *
   * @param organizationId - The organization ID
   * @returns Config document if found, null otherwise
   */
  async findByOrganizationId(organizationId: string): Promise<(IOrgWebhookConfigDocument & IMongoDocument) | null> {
    return this.findOne({ organizationId });
  }

  /**
   * Update the lastDeliveryAt timestamp
   *
   * @param id - Config document ID
   * @returns Updated document
   */
  async updateLastDelivery(id: string): Promise<(IOrgWebhookConfigDocument & IMongoDocument) | null> {
    return this.model.findByIdAndUpdate(id, { $set: { lastDeliveryAt: new Date().toISOString() } }, { new: true });
  }
}

export const orgWebhookConfigRepository = new OrgWebhookConfigRepository(OrgWebhookConfig);

export default OrgWebhookConfig;
