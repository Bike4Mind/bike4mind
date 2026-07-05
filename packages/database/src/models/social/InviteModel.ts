import mongoose, { Model, model, PipelineStage, Schema } from 'mongoose';
import {
  IInviteDocument,
  IInviteModelAdapter,
  IInviteRepository,
  InviteType,
  PaginatedResponse,
} from '@bike4mind/common';
import { Permission } from '@bike4mind/common';
import User from '../auth/UserModel';
import BaseRepository from '@bike4mind/db-core';
import { NotFoundError } from '@bike4mind/utils';
import { convertPipelineForDocumentDB } from '../../utils/documentdb-compat';

export interface IInviteModel extends Model<IInviteDocument, {}>, IInviteModelAdapter {}

/** Escape regex metacharacters so a value matches literally inside a $regex. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the pending-recipient match for a user's email. The email is matched
 * exactly and case-insensitively: the equality arm is index-friendly for the
 * common same-case hit, and the anchored, escaped $regex arm covers case
 * variants without letting email metacharacters (`.`, `+`) over-match a
 * different address.
 */
function pendingEmailMatch(pendingEmail: string) {
  return {
    'recipients.pending': { $exists: true, $ne: [] },
    $or: [
      { 'recipients.pending': pendingEmail },
      { 'recipients.pending': { $regex: `^${escapeRegExp(pendingEmail)}$`, $options: 'i' } },
    ],
  };
}

export const InviteRecipientSchema = new Schema<IInviteDocument['recipients']>({
  pending: {
    type: [String],
    required: false,
  },
  accepted: {
    type: [String],
    default: [],
  },
  refused: {
    type: [String],
    default: [],
  },
});

export const InviteSchema = new Schema<IInviteDocument>(
  {
    type: {
      type: String,
      enum: Object.values(InviteType),
      required: true,
    },
    documentId: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      required: false,
    },
    recipients: {
      type: InviteRecipientSchema,
      required: false,
      default: {
        accepted: [],
        refused: [],
      },
    },
    name: {
      type: String,
      required: false,
    },
    username: {
      type: String,
      required: false,
    },
    accepted: {
      type: Number,
      required: true,
      default: 0,
    },
    remaining: {
      type: Number,
      required: true,
      default: 1,
    },
    expiresAt: {
      type: Date,
      required: false,
    },
    permissions: {
      type: [String],
      enum: Object.values(Permission),
      required: false,
    },
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

export const Invite =
  (mongoose.models.Invite as IInviteModel) ?? model<IInviteDocument, IInviteModel>('Invite', InviteSchema);

export class InviteRepository extends BaseRepository<IInviteDocument> implements IInviteRepository {
  constructor(private inviteModel: IInviteModel) {
    super(inviteModel);
    this.inviteModel = inviteModel;
  }

  async countPendingByUserId(userId: string): Promise<number> {
    const user = await User.findById(userId);
    if (!user) throw new NotFoundError(`User not found: ${userId}`);
    // recipients.pending holds invitee emails, so an emailless user can have no
    // pending invites addressed to them. Guard against a null/undefined/non-string
    // email - passing it as a $regex operand throws MongoServerError
    // "$regex has to be a string".
    const pendingEmail = typeof user.email === 'string' ? user.email.trim() : '';
    if (!pendingEmail) return 0;
    const result = await this.inviteModel.countDocuments(pendingEmailMatch(pendingEmail));
    return result;
  }

  async findAllByDocumentId(documentId: string): Promise<IInviteDocument[]> {
    const result = await this.inviteModel.find({ documentId });

    return result.map(invite => invite.toJSON() as IInviteDocument);
  }

  async findAllByPendingUserIdOrEmail(
    userId: string,
    options?: { limit: number; page: number }
  ): Promise<IInviteDocument[]> {
    const pipeline = [];
    const user = await User.findById(userId);
    if (!user) throw new NotFoundError(`User not found: ${userId}`);
    // recipients.pending holds invitee emails, so an emailless user can have no
    // pending invites addressed to them. Guard against a null/undefined/non-string
    // email - passing it as a $regex operand throws MongoServerError
    // "$regex has to be a string".
    const pendingEmail = typeof user.email === 'string' ? user.email.trim() : '';
    if (!pendingEmail) return [];
    pipeline.push({
      $match: pendingEmailMatch(pendingEmail),
    });

    const types = [
      { type: InviteType.FabFile, collection: 'fabfiles' },
      { type: InviteType.Session, collection: 'sessionmodels' },
      { type: InviteType.Organization, collection: 'organizations' },
      { type: InviteType.Group, collection: 'groups' },
      { type: InviteType.Project, collection: 'projects' },
    ];

    // Always convert documentId to ObjectId for all lookups
    pipeline.push({
      $addFields: {
        documentObjectId: { $toObjectId: '$documentId' },
      },
    });

    // Add all lookups using documentObjectId
    pipeline.push(
      ...types.map(type => ({
        $lookup: {
          from: type.collection,
          localField: 'documentObjectId',
          foreignField: '_id',
          as: type.collection,
        },
      }))
    );

    // Unwind document and projects
    pipeline.push(
      {
        $unwind: {
          path: '$document',
          preserveNullAndEmptyArrays: true,
        },
      },
      ...types.map(type => ({
        $unwind: {
          path: `$${type.collection}`,
          preserveNullAndEmptyArrays: true,
        },
      }))
    );

    // Project only the fields we need
    pipeline.push({
      $project: {
        _id: 1,
        type: 1,
        documentId: 1,
        remaining: 1,
        recipients: 1,
        accepted: 1,
        createdAt: 1,
        updatedAt: 1,
        username: '$username',
        description: 1,
        name: {
          $switch: {
            branches: [
              { case: { $eq: ['$type', InviteType.FabFile] }, then: '$fabfiles.fileName' },
              { case: { $eq: ['$type', InviteType.Session] }, then: '$sessionmodels.name' },
              { case: { $eq: ['$type', InviteType.Organization] }, then: '$organizations.name' },
              { case: { $eq: ['$type', InviteType.Group] }, then: '$groups.name' },
              { case: { $eq: ['$type', InviteType.Project] }, then: '$projects.name' },
            ],
            default: null,
          },
        },
      },
    });
    // Then, get the paginated results
    if (options) {
      const { limit, page } = options;
      const skip = (page - 1) * limit;
      // First, get the total count

      pipeline.push(
        ...[
          // Skip and limit for pagination
          {
            $skip: skip,
          },
          {
            $limit: limit,
          },
          // Sort by most recent first
          {
            $sort: { createdAt: -1 },
          },
        ]
      );
    }

    try {
      const convertedPipeline = convertPipelineForDocumentDB(pipeline);
      const result = await this.model.aggregate<IInviteDocument>(convertedPipeline as unknown as PipelineStage[]);
      const hydrated = result.map(r => this.inviteModel.hydrate(r).toObject());
      return hydrated;
    } catch (e) {
      console.error('FAILED', e);
      return [];
    }
  }

  async searchInvites(
    query: Record<string, unknown>,
    limit: number,
    page: number
  ): Promise<PaginatedResponse<IInviteDocument>> {
    const results = await this.inviteModel
      .find(query)
      .skip(limit * (page - 1))
      .limit(limit + 1);

    const total = await this.inviteModel.countDocuments(query);

    return {
      data: results.map(r => r.toJSON() as IInviteDocument),
      meta: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        total,
      },
    };
  }
}

export const inviteRepository = new InviteRepository(Invite);

export default Invite;
