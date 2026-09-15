import {
  IJiraWebhookSubscriptionDocument,
  IJiraWebhookSubscriptionRepository,
  IMongoDocument,
} from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * User subscription to Jira webhook events.
 *
 * Enables individual users or teams to receive filtered Jira events in Slack.
 * Filters are applied on our receiver before sending to Slack (not by Jira).
 */
const JiraWebhookSubscriptionSchema = new Schema<IJiraWebhookSubscriptionDocument>(
  {
    userId: { type: String, required: true },
    webhookConfigId: { type: String, required: true },
    atlassianCloudId: { type: String, required: true },
    slackTarget: {
      type: Schema.Types.Mixed,
      required: true,
    },
    projectFilter: { type: [String], default: [] },
    priorityFilter: { type: [String], default: [] },
    issueTypeFilter: { type: [String], default: [] },
    name: { type: String },
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

// Unique index to ensure one subscription per user per webhook config
JiraWebhookSubscriptionSchema.index({ userId: 1, webhookConfigId: 1 }, { unique: true, name: 'jira_sub_user_config' });

// Compound index for fan-out query: findActiveByWebhookConfig()
JiraWebhookSubscriptionSchema.index({ webhookConfigId: 1, enabled: 1 }, { name: 'jira_sub_config_enabled' });

// Index for user's subscriptions lookup
JiraWebhookSubscriptionSchema.index({ userId: 1 }, { name: 'jira_sub_user' });

// Index for cascade delete when webhook config is removed
JiraWebhookSubscriptionSchema.index({ webhookConfigId: 1 }, { name: 'jira_sub_config' });

export interface IJiraWebhookSubscriptionModel extends Model<IJiraWebhookSubscriptionDocument & IMongoDocument> {}

export const JiraWebhookSubscription: IJiraWebhookSubscriptionModel =
  mongoose.models.JiraWebhookSubscription ??
  model<IJiraWebhookSubscriptionDocument>('JiraWebhookSubscription', JiraWebhookSubscriptionSchema);

class JiraWebhookSubscriptionRepository
  extends BaseRepository<IJiraWebhookSubscriptionDocument & IMongoDocument>
  implements IJiraWebhookSubscriptionRepository
{
  /**
   * Find all subscriptions for a user
   */
  async findByUserId(userId: string): Promise<(IJiraWebhookSubscriptionDocument & IMongoDocument)[]> {
    return this.find({ userId });
  }

  /**
   * Find all active subscriptions for a webhook config (for fan-out)
   */
  async findActiveByWebhookConfig(
    webhookConfigId: string
  ): Promise<(IJiraWebhookSubscriptionDocument & IMongoDocument)[]> {
    return this.find({ webhookConfigId, enabled: true });
  }

  /**
   * Find subscription by user and webhook config (unique constraint)
   */
  async findByUserAndConfig(
    userId: string,
    webhookConfigId: string
  ): Promise<(IJiraWebhookSubscriptionDocument & IMongoDocument) | null> {
    return this.findOne({ userId, webhookConfigId });
  }

  /**
   * Count subscribers for a webhook config
   */
  async countByWebhookConfig(webhookConfigId: string): Promise<number> {
    return this.count({ webhookConfigId, enabled: true });
  }

  /**
   * Delete all subscriptions for a webhook config (cascade delete)
   * @returns The number of subscriptions deleted
   */
  async deleteByWebhookConfig(webhookConfigId: string): Promise<number> {
    const result = await this.model.deleteMany({ webhookConfigId });
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
   * Reset consecutive failure count on successful delivery
   */
  async resetConsecutiveFailures(subscriptionId: string): Promise<void> {
    await this.model.findByIdAndUpdate(subscriptionId, {
      consecutiveFailures: 0,
      circuitBreakerOpenedAt: null,
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
}

export const jiraWebhookSubscriptionRepository = new JiraWebhookSubscriptionRepository(JiraWebhookSubscription);

export default JiraWebhookSubscription;
