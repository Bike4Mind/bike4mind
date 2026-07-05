/**
 * @deprecated This model is deprecated and will be removed after data migration to Subscription model completes.
 * Use Subscription model with ownerType='User' instead.
 */

import { mongoose } from '@bike4mind/database';
import BaseRepository from '@bike4mind/database';
import { IUserSubscriptionRepository, IUserSubscription } from '@client/lib/userSubscriptions/types';
import escapeStringRegexp from 'escape-string-regexp';
import { executeFacetCompatible, convertPipelineForDocumentDB } from '@bike4mind/database';

const UserSubscriptionSchema = new mongoose.Schema<IUserSubscription>(
  {
    userId: { type: String, required: true },
    subscriptionId: { type: String, required: true, unique: true },
    priceId: { type: String, required: true },
    status: { type: String, required: true },
    canceledAt: { type: Date, default: null },
    periodStartsAt: { type: Date, required: true },
    periodEndsAt: { type: Date, required: true },
    customCreditsPerCycle: { type: Number, required: false },
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

// Indexes
UserSubscriptionSchema.index({ userId: 1, status: 1 });
UserSubscriptionSchema.index({ priceId: 1, userId: 1, status: 1 });
UserSubscriptionSchema.index({ periodEndsAt: 1, status: 1 });

export const UserSubscription =
  mongoose.models.UserSubscription || mongoose.model('UserSubscription', UserSubscriptionSchema);

class UserSubscriptionRepository extends BaseRepository<IUserSubscription> implements IUserSubscriptionRepository {
  constructor(model: mongoose.Model<IUserSubscription>) {
    super(model);
  }

  async findActiveSubscriptionsByUserId(userId: string) {
    return this.find({
      userId,
      status: 'active',
    });
  }

  async findByPriceIdAndUserId(
    priceId: string,
    userId: string,
    status: IUserSubscription['status'] = 'active'
  ): Promise<IUserSubscription | null> {
    const subscription = await this.findOne({
      priceId,
      userId,
      status,
    });

    return subscription ?? null;
  }

  async updateByStripeSubscriptionId(subscriptionId: string, data: Partial<IUserSubscription>) {
    const subscription = await this.model.findOneAndUpdate(
      {
        subscriptionId,
      },
      data,
      { new: true }
    );

    return subscription ?? null;
  }

  /**
   * Find all subscriptions with user details
   * @param search Optional search term for user email or name
   * @param page Page number (1-indexed)
   * @param limit Number of items per page
   * @returns Object containing subscriptions array and pagination metadata
   */
  async findWithUserDetails(search?: string, page = 1, limit = 10) {
    const skip = (page - 1) * limit;

    const pipeline: any[] = [
      {
        $lookup: {
          from: 'users',
          let: { userId: { $toObjectId: '$userId' } },
          pipeline: [{ $match: { $expr: { $eq: ['$_id', '$$userId'] } } }],
          as: 'user',
        },
      },
      {
        $unwind: {
          path: '$user',
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $project: {
          _id: 1,
          userId: 1,
          subscriptionId: 1,
          priceId: 1,
          status: 1,
          canceledAt: 1,
          periodStartsAt: 1,
          periodEndsAt: 1,
          createdAt: 1,
          updatedAt: 1,
          'user.username': 1,
          'user.name': 1,
          'user.email': 1,
          'user._id': 1,
        },
      },
    ];

    // Add search filter if provided
    if (search && search.trim() !== '') {
      const MAX_SEARCH_LENGTH = 100; // Prevent extremely long search patterns
      const safeSearch = search.slice(0, MAX_SEARCH_LENGTH);
      const searchRegex = new RegExp(escapeStringRegexp(safeSearch), 'i');
      pipeline.splice(2, 0, {
        $match: {
          $or: [{ 'user.email': { $regex: searchRegex } }, { 'user.name': { $regex: searchRegex } }],
        },
      });
    }

    // Use DocumentDB compatible aggregation
    const convertedPipeline = convertPipelineForDocumentDB(pipeline);

    const results = await executeFacetCompatible(this.model, convertedPipeline, {
      metadata: [{ $count: 'total' }],
      data: [{ $skip: skip }, { $limit: limit }],
    });

    // Extract and format the results
    const subscriptions = results[0].data || [];
    const total = results[0].metadata[0]?.total || 0;

    return {
      subscriptions,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get subscription statistics
   * @returns Object containing counts for total, active, expiring this month, and canceled subscriptions
   */
  async getSubscriptionStats() {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const stats = await executeFacetCompatible(
      this.model,
      [], // No base pipeline
      {
        // Total subscriptions
        total: [{ $count: 'count' }],

        // Active subscriptions
        active: [{ $match: { status: 'active' } }, { $count: 'count' }],

        // Subscriptions expiring this month
        expiringThisMonth: [
          {
            $match: {
              status: 'active',
              periodEndsAt: { $gte: startOfMonth, $lte: endOfMonth },
            },
          },
          { $count: 'count' },
        ],

        // Canceled subscriptions
        canceled: [{ $match: { canceledAt: { $ne: null } } }, { $count: 'count' }],
      }
    );

    const facetResult = stats[0] || {};

    // Handle case where counts might be null (no documents)
    return {
      total: facetResult.total?.[0]?.count || 0,
      active: facetResult.active?.[0]?.count || 0,
      expiringThisMonth: facetResult.expiringThisMonth?.[0]?.count || 0,
      canceled: facetResult.canceled?.[0]?.count || 0,
    };
  }

  async findBySubscriptionId(subscriptionId: string) {
    return this.findOne({
      subscriptionId,
    });
  }
}

export const userSubscriptionRepository = new UserSubscriptionRepository(UserSubscription);
