import {
  IWebhookDeliveryDocument,
  IWebhookDeliveryRepository,
  WebhookDeliveryStatus,
  IMongoDocument,
} from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * Webhook delivery audit trail.
 *
 * Records each webhook delivery attempt for debugging and compliance.
 * Uses TTL index for automatic cleanup (7-day retention).
 */
// Assigned to a variable to avoid excess-property-check TS2561: Mongoose v8's
// SchemaDefinitionType<T> can't infer SchemaDefinitionProperty for union string
// literal types ('outbound_http' | 'org_notification'), so it drops deliveryKind
// from the inferred key set. Non-literal assignment bypasses the excess-property check.
const webhookDeliverySchemaFields = {
  deliveryId: { type: String, required: true },
  organizationId: { type: String, required: true },
  subscriptionId: { type: String },
  userId: { type: String, required: true },
  eventType: { type: String, required: true },
  repository: { type: String, required: true },
  status: {
    type: String,
    enum: Object.values(WebhookDeliveryStatus),
    required: true,
  },
  processingDurationMs: { type: Number },
  errorMessage: { type: String },
  correlationId: { type: String },
  retryCount: { type: Number, default: 0 },
  payload: { type: Schema.Types.Mixed },
  targetUrl: { type: String },
  deliveryKind: {
    type: String,
    enum: ['outbound_http', 'org_notification'],
  },
};

const WebhookDeliverySchema = new Schema<IWebhookDeliveryDocument>(webhookDeliverySchemaFields, {
  timestamps: true,
  toJSON: {
    virtuals: true,
  },
  toObject: {
    virtuals: true,
  },
});

// TTL index for automatic cleanup (7 days = 604800 seconds)
WebhookDeliverySchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800, name: 'webhook_delivery_ttl' });

// Index for deduplication lookup
WebhookDeliverySchema.index({ deliveryId: 1 }, { name: 'webhook_delivery_id' });

// Compound index for per-subscriber deduplication
WebhookDeliverySchema.index(
  { deliveryId: 1, subscriptionId: 1 },
  { unique: true, sparse: true, name: 'webhook_delivery_sub_dedup' }
);

// Index for subscription history lookup (sorted by date)
WebhookDeliverySchema.index({ subscriptionId: 1, createdAt: -1 }, { name: 'webhook_delivery_sub_history' });

// Index for organization history lookup (admin view)
WebhookDeliverySchema.index({ organizationId: 1, createdAt: -1 }, { name: 'webhook_delivery_org_history' });

export interface IWebhookDeliveryModel extends Model<IWebhookDeliveryDocument & IMongoDocument> {}

export const WebhookDelivery: IWebhookDeliveryModel =
  mongoose.models.WebhookDelivery ?? model<IWebhookDeliveryDocument>('WebhookDelivery', WebhookDeliverySchema);

class WebhookDeliveryRepository
  extends BaseRepository<IWebhookDeliveryDocument & IMongoDocument>
  implements IWebhookDeliveryRepository
{
  /**
   * Find deliveries for a subscription (for history view)
   */
  async findBySubscription(subscriptionId: string, limit = 50): Promise<(IWebhookDeliveryDocument & IMongoDocument)[]> {
    return this.find({ subscriptionId }, { sort: { createdAt: -1 }, limit });
  }

  /**
   * Find deliveries for an organization (for admin view)
   */
  async findByOrganization(
    organizationId: string,
    limit = 100
  ): Promise<(IWebhookDeliveryDocument & IMongoDocument)[]> {
    return this.find({ organizationId }, { sort: { createdAt: -1 }, limit });
  }

  /**
   * Check if delivery already exists (for deduplication)
   */
  async findByDeliveryId(deliveryId: string): Promise<(IWebhookDeliveryDocument & IMongoDocument) | null> {
    return this.findOne({ deliveryId });
  }

  /**
   * Check if delivery exists for specific subscriber (per-subscriber dedup)
   */
  async findByDeliveryAndSubscription(
    deliveryId: string,
    subscriptionId: string
  ): Promise<(IWebhookDeliveryDocument & IMongoDocument) | null> {
    return this.findOne({ deliveryId, subscriptionId });
  }

  /**
   * Create a delivery record with deduplication
   * Returns null if record already exists (duplicate delivery)
   */
  async createIfNotExists(
    data: Omit<IWebhookDeliveryDocument, 'id' | 'updatedAt' | 'createdAt'>
  ): Promise<(IWebhookDeliveryDocument & IMongoDocument) | null> {
    try {
      return await this.create(data);
    } catch (error) {
      // Handle duplicate key error (already delivered to this subscriber)
      if ((error as { code?: number }).code === 11000) {
        return null;
      }
      throw error;
    }
  }

  // Pagination methods for delivery history

  /**
   * Find deliveries for a subscription with pagination and optional filters
   */
  async findBySubscriptionPaginated(
    subscriptionId: string,
    options: {
      skip?: number;
      limit?: number;
      status?: WebhookDeliveryStatus;
      since?: Date;
    } = {}
  ): Promise<(IWebhookDeliveryDocument & IMongoDocument)[]> {
    const { skip = 0, limit = 20, status, since } = options;

    const query: Record<string, unknown> = { subscriptionId };

    if (status) {
      query.status = status;
    }

    if (since) {
      query.createdAt = { $gte: since };
    }

    return this.find(query, { sort: { createdAt: -1 }, skip, limit });
  }

  /**
   * Count deliveries for a subscription with optional filters
   */
  async countBySubscription(
    subscriptionId: string,
    options: {
      status?: WebhookDeliveryStatus;
      since?: Date;
    } = {}
  ): Promise<number> {
    const { status, since } = options;

    const query: Record<string, unknown> = { subscriptionId };

    if (status) {
      query.status = status;
    }

    if (since) {
      query.createdAt = { $gte: since };
    }

    return this.count(query);
  }

  /**
   * Find deliveries for an organization with pagination
   */
  async findByOrganizationPaginated(
    organizationId: string,
    options: {
      skip?: number;
      limit?: number;
      status?: WebhookDeliveryStatus;
    } = {}
  ): Promise<(IWebhookDeliveryDocument & IMongoDocument)[]> {
    const { skip = 0, limit = 20, status } = options;

    const query: Record<string, unknown> = { organizationId };

    if (status) {
      query.status = status;
    }

    return this.find(query, { sort: { createdAt: -1 }, skip, limit });
  }

  /**
   * Count deliveries for an organization with optional filters
   */
  async countByOrganization(
    organizationId: string,
    options: {
      status?: WebhookDeliveryStatus;
    } = {}
  ): Promise<number> {
    const { status } = options;

    const query: Record<string, unknown> = { organizationId };

    if (status) {
      query.status = status;
    }

    return this.count(query);
  }

  /**
   * Find deliveries for a user across all subscriptions with pagination
   */
  async findByUserPaginated(
    userId: string,
    options: {
      skip?: number;
      limit?: number;
      status?: WebhookDeliveryStatus;
      subscriptionId?: string;
      since?: Date;
    } = {}
  ): Promise<(IWebhookDeliveryDocument & IMongoDocument)[]> {
    const { skip = 0, limit = 20, status, subscriptionId, since } = options;

    const query: Record<string, unknown> = { userId };

    if (status) {
      query.status = status;
    }

    if (subscriptionId) {
      query.subscriptionId = subscriptionId;
    }

    if (since) {
      query.createdAt = { $gte: since };
    }

    return this.find(query, { sort: { createdAt: -1 }, skip, limit });
  }

  /**
   * Count deliveries for a user with optional filters
   */
  async countByUser(
    userId: string,
    options: {
      status?: WebhookDeliveryStatus;
      subscriptionId?: string;
      since?: Date;
    } = {}
  ): Promise<number> {
    const { status, subscriptionId, since } = options;

    const query: Record<string, unknown> = { userId };

    if (status) {
      query.status = status;
    }

    if (subscriptionId) {
      query.subscriptionId = subscriptionId;
    }

    if (since) {
      query.createdAt = { $gte: since };
    }

    return this.count(query);
  }
}

export const webhookDeliveryRepository = new WebhookDeliveryRepository(WebhookDelivery);

export default WebhookDelivery;
