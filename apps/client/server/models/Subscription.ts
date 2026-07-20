import { mongoose } from '@bike4mind/database';
import {
  ISubscription,
  ISubscriptionRepository,
  SubscriptionOwnerType,
  SubscriptionSource,
} from '@client/lib/subscriptions/types';
import BaseRepository from '@bike4mind/database';
import { IMongoDocument } from '@bike4mind/common';
import { executeFacetCompatible } from '@bike4mind/database';

const SubscriptionSchema = new mongoose.Schema<ISubscription>(
  {
    ownerType: {
      type: String,
      enum: SubscriptionOwnerType,
      required: true,
    },
    ownerId: {
      type: String,
      required: true,
    },
    // Required: every row carries a unique subscriptionId. Stripe-managed
    // rows use the Stripe sub id; admin_grant rows use a sentinel of the form
    // `admin_grant_<uuid>` so the non-sparse unique index below has a real
    // value to enforce uniqueness on. DocumentDB does not honour sparse on a
    // unique index - missing values are treated as null and collide - so we
    // never leave this field unset.
    subscriptionId: {
      type: String,
      required: true,
    },
    priceId: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      required: true,
    },
    source: {
      type: String,
      enum: Object.values(SubscriptionSource),
      required: true,
      default: SubscriptionSource.Stripe,
    },
    grantedBy: {
      type: String,
      required: false,
    },
    grantedReason: {
      type: String,
      required: false,
    },
    canceledAt: {
      type: Date,
      default: null,
    },
    periodStartsAt: {
      type: Date,
      required: true,
    },
    periodEndsAt: {
      type: Date,
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
    },
    customCreditsPerCycle: {
      type: Number,
      required: false,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Unique on subscriptionId. Non-sparse because DocumentDB ignores `sparse` on
// unique indexes (missing values are treated as null and collide). Every row
// - Stripe-managed or admin_grant - must write a real, unique subscriptionId.
SubscriptionSchema.index({ subscriptionId: 1 }, { unique: true });

// Add compound indexes for frequently used queries
SubscriptionSchema.index({ ownerType: 1, ownerId: 1, status: 1 }); // For findActiveSubscriptionsByOwner
SubscriptionSchema.index({ priceId: 1, ownerType: 1, ownerId: 1, status: 1 }); // For findByPriceIdAndOwner
SubscriptionSchema.index({ periodEndsAt: 1, status: 1 }); // For subscription expiry queries
// Admin grants listing in /api/admin/organizations/grants - small cardinality query
SubscriptionSchema.index({ ownerType: 1, source: 1, status: 1 });

export const Subscription =
  mongoose.models.Subscription || mongoose.model<ISubscription>('Subscription', SubscriptionSchema);

class SubscriptionRepository extends BaseRepository<ISubscription & IMongoDocument> implements ISubscriptionRepository {
  constructor(model: mongoose.Model<ISubscription & IMongoDocument>) {
    super(model);
  }

  findByStripeSubscriptionId(subscriptionId: string): Promise<(ISubscription & IMongoDocument) | null> {
    // Defensive guard: callers occasionally pass an undefined Stripe id (e.g.
    // an unflipped admin_grant). Without this, `findOne({ subscriptionId:
    // undefined })` would match the first row in the collection.
    if (!subscriptionId) return Promise.resolve(null);
    return this.model
      .findOne({
        subscriptionId,
      })
      .lean({ virtuals: true });
  }

  findActiveSubscriptionsByOwner(
    ownerType: SubscriptionOwnerType,
    ownerId: string
  ): Promise<(ISubscription & IMongoDocument)[]> {
    return this.model
      .find({
        ownerType,
        ownerId,
        status: 'active',
      })
      .lean({ virtuals: true });
  }

  findByPriceIdAndOwner(
    priceId: string,
    ownerType: SubscriptionOwnerType,
    ownerId: string,
    status: ISubscription['status'] = 'active'
  ): Promise<ISubscription | null> {
    return this.model
      .findOne({
        priceId,
        ownerType,
        ownerId,
        status,
      })
      .lean({ virtuals: true });
  }

  updateByStripeSubscriptionId(subscriptionId: string, data: Partial<ISubscription>): Promise<ISubscription | null> {
    // Same guard as findByStripeSubscriptionId: never run a filter with an
    // undefined subscriptionId, which would match every admin_grant row.
    if (!subscriptionId) return Promise.resolve(null);
    return this.model
      .findOneAndUpdate(
        {
          subscriptionId,
        },
        data,
        {
          new: true,
        }
      )
      .lean({ virtuals: true });
  }

  /**
   * Find all subscriptions with owner details (User or Organization)
   * @param search Optional search term for owner email or name
   * @param page Page number (1-indexed)
   * @param limit Number of items per page
   * @param ownerType Optional filter by owner type
   * @returns Object containing subscriptions array and pagination metadata
   */
  async findWithOwnerDetails(
    search?: string,
    page = 1,
    limit = 10,
    ownerType?: SubscriptionOwnerType
  ): Promise<{
    subscriptions: ISubscription[];
    pagination: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const skip = (page - 1) * limit;

    const pipeline: any[] = [];

    // Filter by ownerType if specified
    if (ownerType) {
      pipeline.push({
        $match: { ownerType },
      });
    }

    // Lookup owner details based on ownerType
    pipeline.push({
      $lookup: {
        from: 'users',
        let: {
          ownerId: { $toObjectId: '$ownerId' },
          ownerType: '$ownerType',
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [{ $eq: ['$$ownerType', 'User'] }, { $eq: ['$_id', '$$ownerId'] }],
              },
            },
          },
        ],
        as: 'userOwner',
      },
    });

    pipeline.push({
      $lookup: {
        from: 'organizations',
        let: {
          ownerId: { $toObjectId: '$ownerId' },
          ownerType: '$ownerType',
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [{ $eq: ['$$ownerType', 'Organization'] }, { $eq: ['$_id', '$$ownerId'] }],
              },
            },
          },
        ],
        as: 'orgOwner',
      },
    });

    // Combine owner details into single field
    pipeline.push({
      $addFields: {
        owner: {
          $cond: {
            if: { $eq: ['$ownerType', 'User'] },
            then: { $arrayElemAt: ['$userOwner', 0] },
            else: { $arrayElemAt: ['$orgOwner', 0] },
          },
        },
      },
    });

    pipeline.push({
      $project: {
        _id: 1,
        ownerType: 1,
        ownerId: 1,
        subscriptionId: 1,
        priceId: 1,
        status: 1,
        source: 1,
        grantedBy: 1,
        grantedReason: 1,
        canceledAt: 1,
        periodStartsAt: 1,
        periodEndsAt: 1,
        quantity: 1,
        customCreditsPerCycle: 1,
        createdAt: 1,
        updatedAt: 1,
        'owner.username': 1,
        'owner.name': 1,
        'owner.email': 1,
        'owner._id': 1,
      },
    });

    // Add id virtual (Mongoose default: converts _id to string)
    pipeline.push({
      $addFields: {
        id: { $toString: '$_id' },
      },
    });

    // Add search filter if provided
    if (search && search.trim() !== '') {
      const MAX_SEARCH_LENGTH = 100;
      const safeSearch = search.slice(0, MAX_SEARCH_LENGTH);
      const searchRegex = new RegExp(safeSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      pipeline.splice(pipeline.length - 1, 0, {
        $match: {
          $or: [{ 'owner.email': { $regex: searchRegex } }, { 'owner.name': { $regex: searchRegex } }],
        },
      });
    }

    // Use DocumentDB compatible aggregation
    const { convertPipelineForDocumentDB } = await import('@bike4mind/database');
    const convertedPipeline = convertPipelineForDocumentDB(pipeline);

    const results = await executeFacetCompatible(this.model, convertedPipeline, {
      metadata: [{ $count: 'total' }],
      data: [{ $skip: skip }, { $limit: limit }],
    });

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

  // Convenience methods for user subscriptions
  findActiveUserSubscriptions(userId: string): Promise<(ISubscription & IMongoDocument)[]> {
    return this.findActiveSubscriptionsByOwner(SubscriptionOwnerType.User, userId);
  }

  /**
   * Find ALL user subscriptions (active, canceled, past)
   * Used by /api/subscriptions/own to display subscription history
   */
  findAllUserSubscriptions(userId: string): Promise<(ISubscription & IMongoDocument)[]> {
    return this.model
      .find({
        ownerType: SubscriptionOwnerType.User,
        ownerId: userId,
      })
      .lean({ virtuals: true });
  }

  findUserSubscriptionByPriceId(
    priceId: string,
    userId: string,
    status: ISubscription['status'] = 'active'
  ): Promise<ISubscription | null> {
    return this.findByPriceIdAndOwner(priceId, SubscriptionOwnerType.User, userId, status);
  }

  /**
   * Atomic flip of an admin_grant subscription to source='stripe'. Returns
   * the post-update document on success, or null if the row was already
   * flipped by another writer (we lost the race - caller should treat as
   * a no-op rather than re-write). Required because two webhook deliveries
   * for the same conversion could otherwise both flip the same row.
   */
  flipAdminGrantToStripe(adminGrantId: string, data: Partial<ISubscription>): Promise<ISubscription | null> {
    return this.model
      .findOneAndUpdate(
        { _id: new mongoose.Types.ObjectId(adminGrantId), source: 'admin_grant' },
        { $set: data },
        { new: true }
      )
      .lean({ virtuals: true });
  }

  findUserSubscriptionById(subscriptionId: string): Promise<ISubscription | null> {
    if (!subscriptionId) return Promise.resolve(null);
    return this.model
      .findOne({
        subscriptionId,
        ownerType: SubscriptionOwnerType.User,
      })
      .lean({ virtuals: true });
  }

  /**
   * Get subscription statistics
   * @param ownerType Optional filter by owner type (User or Organization). If not provided, returns stats for all subscriptions.
   * @returns Object containing counts for total, active, expiring this month, and canceled subscriptions
   */
  async getSubscriptionStats(ownerType?: SubscriptionOwnerType) {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    // Base pipeline to filter by ownerType if specified
    const basePipeline = ownerType ? [{ $match: { ownerType } }] : [];

    // Execute with DocumentDB compatibility
    const stats = await executeFacetCompatible(this.model, basePipeline, {
      // Total subscriptions
      total: [{ $count: 'count' }],

      // Active subscriptions
      // NOTE: "live subscriber" here = `status: 'active'` on User-owned subs.
      // This exact definition is mirrored (hand-transcribed, raw collection)
      // by the Overwatch product-stats self-report cron in the premium
      // overlay, which cannot import this model. If the live-status set ever
      // changes (e.g. counting `trialing`), update that mirror in the same
      // change or the dashboard's subscriber count silently diverges.
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
    });

    // Handle case where counts might be null (no documents)
    const result = stats[0] || {};
    return {
      total: result.total?.[0]?.count || 0,
      active: result.active?.[0]?.count || 0,
      expiringThisMonth: result.expiringThisMonth?.[0]?.count || 0,
      canceled: result.canceled?.[0]?.count || 0,
    };
  }
}

export const subscriptionRepository = new SubscriptionRepository(Subscription);
