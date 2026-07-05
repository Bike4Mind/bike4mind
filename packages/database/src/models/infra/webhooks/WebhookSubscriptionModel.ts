import { IWebhookSubscriptionDocument, IWebhookSubscriptionRepository, IMongoDocument } from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * User subscription to organization-level GitHub webhooks.
 *
 * Enables individual users to receive webhook events from org-configured repositories.
 * Users explicitly opt-in by subscribing to specific repos within their organization.
 */
const WebhookSubscriptionSchema = new Schema<IWebhookSubscriptionDocument>(
  {
    userId: { type: String, required: true },
    organizationId: { type: String, required: true },
    repos: { type: [String], default: [] },
    events: { type: [String], default: [] },
    mcpServerId: { type: String },
    enabled: { type: Boolean, default: true },
    // Circuit breaker fields
    consecutiveFailures: { type: Number, default: 0 },
    circuitBreakerOpenedAt: { type: Date, default: null },
    autoDisabledAt: { type: Date, default: null },
    autoDisabledReason: { type: String, default: null },
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

// Unique index to ensure one subscription per user per organization
WebhookSubscriptionSchema.index({ userId: 1, organizationId: 1 }, { unique: true, name: 'webhook_sub_user_org' });

// Compound index for fan-out query: findByOrgAndRepo()
// Covers: { organizationId, enabled: true, $or: [{ repos: $in }, { repos: $size: 0 }] }
WebhookSubscriptionSchema.index({ organizationId: 1, enabled: 1, repos: 1 }, { name: 'webhook_sub_org_enabled_repos' });

// Index for user's subscriptions lookup
WebhookSubscriptionSchema.index({ userId: 1 }, { name: 'webhook_sub_user' });

export interface IWebhookSubscriptionModel extends Model<IWebhookSubscriptionDocument & IMongoDocument> {}

export const WebhookSubscription: IWebhookSubscriptionModel =
  mongoose.models.WebhookSubscription ??
  model<IWebhookSubscriptionDocument>('WebhookSubscription', WebhookSubscriptionSchema);

class WebhookSubscriptionRepository
  extends BaseRepository<IWebhookSubscriptionDocument & IMongoDocument>
  implements IWebhookSubscriptionRepository
{
  /**
   * Find all subscriptions for a user
   */
  async findByUserId(userId: string): Promise<(IWebhookSubscriptionDocument & IMongoDocument)[]> {
    return this.find({ userId });
  }

  /**
   * Find all active subscriptions for an organization (for fan-out)
   */
  async findActiveByOrganization(organizationId: string): Promise<(IWebhookSubscriptionDocument & IMongoDocument)[]> {
    return this.find({ organizationId, enabled: true });
  }

  /**
   * Find subscriptions matching org and repo (for event delivery)
   * Uses $in to match repos array containing the specified repo
   */
  async findByOrgAndRepo(
    organizationId: string,
    repo: string
  ): Promise<(IWebhookSubscriptionDocument & IMongoDocument)[]> {
    return this.find({
      organizationId,
      enabled: true,
      $or: [
        { repos: { $in: [repo] } }, // User subscribed to this specific repo
        { repos: { $size: 0 } }, // Or user subscribed to all repos (empty array = all)
      ],
    });
  }

  /**
   * Find subscription by user and org (unique constraint)
   */
  async findByUserAndOrg(
    userId: string,
    organizationId: string
  ): Promise<(IWebhookSubscriptionDocument & IMongoDocument) | null> {
    return this.findOne({ userId, organizationId });
  }

  /**
   * Delete all subscriptions for a user in an organization (for user removal cleanup)
   */
  async deleteByUserAndOrg(userId: string, organizationId: string): Promise<void> {
    await this.model.deleteMany({ userId, organizationId });
  }

  /**
   * Count subscribers for an organization
   */
  async countByOrganization(organizationId: string): Promise<number> {
    return this.count({ organizationId, enabled: true });
  }

  /**
   * Delete all subscriptions for an organization (cascade delete when org webhook config is removed)
   * @returns The number of subscriptions deleted
   */
  async deleteByOrganization(organizationId: string): Promise<number> {
    const result = await this.model.deleteMany({ organizationId });
    return result.deletedCount ?? 0;
  }

  // Circuit breaker methods

  /**
   * Atomically increment consecutive failure count and check threshold.
   * Uses a single atomic operation to prevent TOCTOU race conditions.
   *
   * @returns Object with new failure count and whether auto-disable was triggered
   */
  async incrementConsecutiveFailuresAtomic(
    subscriptionId: string,
    threshold: number,
    reason: string
  ): Promise<{ newFailureCount: number; wasAutoDisabled: boolean }> {
    // First, atomically increment if not already at/past threshold
    const incrementResult = await this.model.findOneAndUpdate(
      {
        _id: subscriptionId,
        consecutiveFailures: { $lt: threshold },
        autoDisabledAt: null, // Not already auto-disabled
      },
      { $inc: { consecutiveFailures: 1 } },
      { new: true }
    );

    if (incrementResult) {
      const newCount = incrementResult.consecutiveFailures ?? 0;

      // If we hit the threshold, atomically disable
      if (newCount >= threshold) {
        // Use conditional update to ensure only one Lambda triggers the disable
        const disableResult = await this.model.findOneAndUpdate(
          {
            _id: subscriptionId,
            consecutiveFailures: { $gte: threshold },
            autoDisabledAt: null, // Only if not already disabled
          },
          {
            enabled: false,
            autoDisabledAt: new Date(),
            autoDisabledReason: reason,
            circuitBreakerOpenedAt: new Date(),
          },
          { new: true }
        );

        return {
          newFailureCount: newCount,
          wasAutoDisabled: disableResult !== null,
        };
      }

      return { newFailureCount: newCount, wasAutoDisabled: false };
    }

    // Subscription not found, already disabled, or at threshold
    const existing = await this.findById(subscriptionId);
    return {
      newFailureCount: existing?.consecutiveFailures ?? 0,
      wasAutoDisabled: false,
    };
  }

  /**
   * Increment consecutive failure count for a subscription.
   * Returns the new failure count.
   * @deprecated Use incrementConsecutiveFailuresAtomic for race-safe operations
   */
  async incrementConsecutiveFailures(subscriptionId: string): Promise<number> {
    const result = await this.model.findByIdAndUpdate(
      subscriptionId,
      { $inc: { consecutiveFailures: 1 } },
      { new: true }
    );
    return result?.consecutiveFailures ?? 0;
  }

  /**
   * Reset consecutive failure count on successful delivery
   */
  async resetConsecutiveFailures(subscriptionId: string): Promise<void> {
    await this.model.findByIdAndUpdate(subscriptionId, {
      consecutiveFailures: 0,
      circuitBreakerOpenedAt: null,
    });
  }

  /**
   * Auto-disable subscription due to circuit breaker threshold
   * @deprecated Use incrementConsecutiveFailuresAtomic for race-safe operations
   */
  async autoDisable(subscriptionId: string, reason: string): Promise<void> {
    await this.model.findByIdAndUpdate(subscriptionId, {
      enabled: false,
      autoDisabledAt: new Date(),
      autoDisabledReason: reason,
      circuitBreakerOpenedAt: new Date(),
    });
  }

  /**
   * Re-enable a previously auto-disabled subscription
   */
  async reEnable(subscriptionId: string): Promise<void> {
    await this.model.findByIdAndUpdate(subscriptionId, {
      enabled: true,
      consecutiveFailures: 0,
      autoDisabledAt: null,
      autoDisabledReason: null,
      circuitBreakerOpenedAt: null,
    });
  }

  /**
   * Find user IDs from the given list that have an active subscription for the org.
   * Efficient batch check using the existing { userId, organizationId } compound index.
   */
  async findActiveSubscriberUserIds(organizationId: string, userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) return [];
    const docs = await this.model
      .find({ organizationId, userId: { $in: userIds }, enabled: true })
      .select('userId')
      .lean();
    return docs.map(d => d.userId);
  }
}

export const webhookSubscriptionRepository = new WebhookSubscriptionRepository(WebhookSubscription);

export default WebhookSubscription;
