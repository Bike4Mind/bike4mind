import { IOrganizationDocument, Permission, IOrganizationRepository, IUserShare } from '@bike4mind/common';
import mongoose, { HydratedDocument, Model, Schema } from 'mongoose';
import { softDeletePlugin } from '../../../utils/mongo';
import BaseRepository from '@bike4mind/db-core';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { ShareableDocumentRepository, ShareableDocumentSchema } from '../../content/SharableDocumentModel';

export interface IOrganizationObject extends HydratedDocument<IOrganizationDocument> {}

interface IOrganizationModel extends Model<IOrganizationDocument, {}> {
  isNew: boolean;
  pushUserPermission: (organizationId: string, userId: string, permission: Permission[]) => Promise<unknown>;
  update: (organization: IOrganizationDocument) => Promise<unknown>;
  findShareAccessById: (userId: string, id: string) => Promise<IOrganizationDocument | null>;
}

const OrganizationSchema = new Schema<IOrganizationDocument>(
  {
    ...ShareableDocumentSchema,
    name: {
      type: String,
      required: true,
    },
    personal: {
      type: Boolean,
      default: true,
    },
    description: {
      type: String,
      required: false,
    },
    billingContact: {
      type: String,
      required: false,
    },
    seats: {
      type: Number,
      default: 10,
    },
    userId: {
      type: String,
      required: true,
    },
    managerId: {
      type: String,
      required: false,
      default: null,
    },
    userDetails: [
      {
        id: {
          type: String,
          required: true,
        },
        email: {
          type: String,
          required: true,
        },
        name: {
          type: String,
          required: true,
        },
        usedCredits: {
          type: Number,
          default: 0,
        },
        lastCreditUsedAt: {
          type: Date,
          default: null,
        },
      },
    ],
    currentCredits: {
      type: Number,
      default: 0,
      required: false,
    },
    lastCreditsPurchasedAt: {
      type: Date,
      default: null,
      required: false,
    },
    logoFileId: {
      type: Schema.Types.ObjectId,
      ref: 'AppFile',
    },
    stripeCustomerId: {
      type: String,
      required: false,
      default: null,
    },
    /**
     * Organization-wide system prompt applied to all team-member conversations. Lets
     * enterprise customers set domain-specific context that overrides model training
     * biases (e.g., a company focused on lunar space elevators).
     */
    systemPrompt: {
      type: String,
      default: '',
      maxlength: 10000, // ~2500 tokens
    },
    preferredModel: { type: String },
    temperature: { type: Number, min: 0, max: 2 },
    maxTokens: { type: Number, min: 1, max: 200000 },
    maxCreditsPerMember: { type: Number, required: false },
  },
  {
    virtuals: true,
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
    statics: {
      findShareAccessById: async function (userId: string, id: string) {
        const result = await this.findOne({ _id: id, 'users.userId': userId });

        if (!result) return null;

        result.users.find((u: IUserShare) => u.userId && u.permissions.includes(Permission.share));

        return result;
      },
      pushUserPermission: function (organizationId: string, userId: string, permission: Permission[]) {
        return this.updateOne({ _id: organizationId }, { $push: { userDetails: { userId, permission } } });
      },
      update: function (organization: IOrganizationDocument) {
        return this.updateOne({ _id: organization.id }, { $set: organization });
      },
    },
  }
);

OrganizationSchema.virtual('logo', {
  ref: 'AppFile',
  localField: 'logoFileId',
  foreignField: '_id',
  justOne: true,
});

// Default seats are applied by the organization manager / creating action, not a pre('save')
// hook - keep schema-side side effects out of the model so the source of the value is explicit.

OrganizationSchema.plugin(softDeletePlugin);

// Per CLAUDE.md MongoDB guideline: performance indexes declared together here,
// never as `index: true` on field definitions. `userId` (billing owner) and
// `managerId` back `findIdsAdministeredBy`'s `$or`, which is on the hot path of
// every `/api/skills` list call.
OrganizationSchema.index({ userId: 1 });
OrganizationSchema.index({ managerId: 1 });

export const Organization =
  (mongoose.models.Organization as IOrganizationModel) ??
  mongoose.model<IOrganizationDocument, IOrganizationModel>('Organization', OrganizationSchema);

export class OrganizationRepository extends BaseRepository<IOrganizationDocument> implements IOrganizationRepository {
  shareable: IOrganizationRepository['shareable'];

  constructor(
    private organizationModel: IOrganizationModel,
    extensions: {
      shareable: IOrganizationRepository['shareable'];
    }
  ) {
    super(organizationModel);
    this.shareable = extensions.shareable;
  }

  async findByStripeCustomerId(stripeCustomerId: string): Promise<IOrganizationDocument | null> {
    return this.organizationModel.findOne({ stripeCustomerId });
  }

  /**
   * Atomically increment the credits of an organization
   * @param organizationId - The ID of the organization
   * @param amount - The amount to increment by (can be negative for decrements)
   * @returns The updated organization document
   */
  async incrementCredits(organizationId: string, amount: number): Promise<IOrganizationDocument | null> {
    return this.organizationModel.findByIdAndUpdate(
      organizationId,
      { $inc: { currentCredits: amount } },
      { new: true }
    );
  }

  /**
   * Search for organizations with filtering, sorting, and pagination
   *
   * @param options - Search options
   * @returns Paginated result of organizations
   */
  async search(
    query: string,
    filters: { personal?: boolean; name?: string; userId?: string },
    pagination: { page: number; limit: number },
    orderBy: { field: keyof IOrganizationDocument; direction: 'asc' | 'desc' }
  ): Promise<{
    data: IOrganizationDocument[];
    hasMore: boolean;
    total: number;
  }> {
    const q: Record<string, unknown> = {};

    if (query) {
      q.$or = [
        { name: { $regex: escapeRegex(query), $options: 'si' } },
        { description: { $regex: escapeRegex(query), $options: 'si' } },
      ];
    }

    if (filters) {
      if (filters.personal !== undefined) {
        q.personal = filters.personal;
      }

      if (filters.name) {
        q.name = { $regex: escapeRegex(filters.name), $options: 'i' };
      }

      if (filters.userId) {
        q.$and = [
          {
            $or: [
              { userId: filters.userId },
              { users: { $elemMatch: { userId: filters.userId, permissions: { $in: ['read'] } } } },
            ],
          },
        ];

        if (q.$or) {
          (q.$and as unknown[]).push({ $or: q.$or });
          delete q.$or; // Remove the $or field to avoid conflicts
        }
      }
    }

    const page = pagination.page || 1;
    const limit = pagination.limit || 10;

    const sortField = orderBy.field || 'name';
    const sortDirection = orderBy.direction || 'asc';

    const skip = (page - 1) * limit;

    const sort: Record<string, 1 | -1> = {
      [sortField]: sortDirection === 'asc' ? 1 : -1,
    };

    const organizations = await this.organizationModel
      .find(q)
      .sort(sort)
      .skip(skip)
      .limit(limit + 1);

    const total = await this.organizationModel.countDocuments(q);

    const hasMore = organizations.length === limit + 1;
    if (hasMore) organizations.pop();

    return {
      data: organizations,
      hasMore,
      total,
    };
  }

  async findByIdAndUserId(id: string, userId: string): Promise<IOrganizationDocument | null> {
    const result = await this.organizationModel.findOne({ _id: id, userId });
    return result?.toObject() || null;
  }

  /**
   * IDs of every organization the user administers (billing owner or assigned
   * manager). Used to surface org-scoped resources - e.g. org-scoped skills -
   * to the people who can manage them, without widening visibility to all
   * members. Returns a bare id list (projection-only) so callers can feed it
   * straight into an `$in` filter.
   */
  async findIdsAdministeredBy(userId: string): Promise<string[]> {
    const orgs = await this.organizationModel
      .find({ $or: [{ userId }, { managerId: userId }] })
      .select('_id')
      .lean();
    return orgs.map(org => org._id.toString());
  }

  async incrementCurrentStorage(organizationId: string, count: number): Promise<void> {
    await this.organizationModel.findByIdAndUpdate(organizationId, [
      {
        $set: {
          currentStorageSize: {
            $max: [0, { $add: [{ $ifNull: ['$currentStorageSize', 0] }, count] }],
          },
        },
      },
      { new: true },
    ]);
  }

  /**
   * Update a user's usage details within an organization.
   * Uses $inc for creditsDelta (atomic increment) and $set for lastCreditUsedAt
   * to avoid race conditions with concurrent requests.
   *
   * @param organizationId - The ID of the organization
   * @param userId - The ID of the user within the organization
   * @param updates - creditsDelta uses $inc for atomicity, lastCreditUsedAt uses $set
   */
  async updateUserDetails(
    organizationId: string,
    userId: string,
    updates: { creditsDelta?: number; lastCreditUsedAt?: Date }
  ): Promise<void> {
    const updateOps: Record<string, Record<string, unknown>> = {};

    if (updates.creditsDelta !== undefined) {
      updateOps.$inc = { 'userDetails.$.usedCredits': updates.creditsDelta };
    }
    if (updates.lastCreditUsedAt !== undefined) {
      updateOps.$set = { 'userDetails.$.lastCreditUsedAt': updates.lastCreditUsedAt };
    }

    if (Object.keys(updateOps).length > 0) {
      const result = await this.organizationModel.updateOne(
        { _id: organizationId, 'userDetails.id': userId },
        updateOps
      );

      if (result.matchedCount === 0) {
        console.warn(
          `updateUserDetails: No userDetails entry found for user ${userId} in organization ${organizationId}. ` +
            'Credits were deducted from the org but usage was not tracked for this user.'
        );
      }
    }
  }
}

export const organizationRepository = new OrganizationRepository(Organization, {
  shareable: new ShareableDocumentRepository(Organization),
});
export default Organization;
