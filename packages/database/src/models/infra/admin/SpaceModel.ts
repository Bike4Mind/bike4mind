import mongoose, { Model, model, Schema } from 'mongoose';
import {
  AddSpaceMemberOptions,
  ISpaceDocument,
  ISpaceMember,
  ISpaceRepository,
  SPACE_DESCRIPTION_MAX,
  SPACE_NAME_MAX,
  SpaceMemberRole,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';
import { softDeletePlugin } from '../../../utils/mongo';

export interface ISpaceModel extends Model<ISpaceDocument> {}

export class SpaceRepository extends BaseRepository<ISpaceDocument> implements ISpaceRepository {
  constructor(model: ISpaceModel) {
    super(model);
  }

  async findLiveById(id: string) {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await this.model.findOne({ _id: id, deletedAt: null });
    return doc?.toJSON() ?? null;
  }

  async listForUser(userId: string) {
    const docs = await this.model
      .find({ deletedAt: null, $or: [{ ownerUserId: userId }, { 'members.userId': userId }] })
      .sort({ name: 1 });
    return docs.map(doc => doc.toJSON());
  }

  countOwned(userId: string) {
    return this.model.countDocuments({ ownerUserId: userId, deletedAt: null });
  }

  async addMember(spaceId: string, member: ISpaceMember, { cap, clearRemoved }: AddSpaceMemberOptions) {
    if (!mongoose.isValidObjectId(spaceId)) return null;
    const filter: Record<string, unknown> = {
      _id: spaceId,
      deletedAt: null,
      ownerUserId: { $ne: member.userId },
      'members.userId': { $ne: member.userId },
      // The cap rides inside the match so concurrent joins cannot overshoot it.
      [`members.${cap - 1}`]: { $exists: false },
    };
    if (!clearRemoved) filter.removedUserIds = { $ne: member.userId };
    const update: Record<string, unknown> = { $push: { members: member } };
    if (clearRemoved) update.$pull = { removedUserIds: member.userId };
    const doc = await this.model.findOneAndUpdate(filter, update, { new: true, runValidators: true });
    return doc?.toJSON() ?? null;
  }

  async removeMember(spaceId: string, userId: string, { block }: { block: boolean }) {
    if (!mongoose.isValidObjectId(spaceId)) return null;
    const update: Record<string, unknown> = { $pull: { members: { userId } } };
    if (block) update.$addToSet = { removedUserIds: userId };
    const doc = await this.model.findOneAndUpdate(
      { _id: spaceId, deletedAt: null, ownerUserId: { $ne: userId }, 'members.userId': userId },
      update,
      { new: true }
    );
    return doc?.toJSON() ?? null;
  }

  async setMemberRole(spaceId: string, userId: string, role: SpaceMemberRole) {
    if (!mongoose.isValidObjectId(spaceId)) return null;
    const doc = await this.model.findOneAndUpdate(
      { _id: spaceId, deletedAt: null, ownerUserId: { $ne: userId }, members: { $elemMatch: { userId } } },
      { $set: { 'members.$.role': role } },
      { new: true, runValidators: true }
    );
    return doc?.toJSON() ?? null;
  }

  async transferOwnership(
    spaceId: string,
    fromUserId: string,
    toUserId: string,
    { clearParent }: { clearParent: boolean }
  ) {
    if (!mongoose.isValidObjectId(spaceId)) return null;
    const doc = await this.model.findOneAndUpdate(
      {
        _id: spaceId,
        deletedAt: null,
        ownerUserId: fromUserId,
        members: { $elemMatch: { userId: toUserId, role: 'admin' } },
      },
      [
        {
          $set: {
            ownerUserId: toUserId,
            members: {
              $concatArrays: [
                { $filter: { input: '$members', as: 'm', cond: { $ne: ['$$m.userId', toUserId] } } },
                [{ userId: fromUserId, role: 'admin', joinedVia: 'invite', joinedAt: '$$NOW' }],
              ],
            },
            ...(clearParent ? { parentOrganizationId: null } : {}),
            updatedAt: '$$NOW',
          },
        },
      ],
      { new: true }
    );
    return doc?.toJSON() ?? null;
  }

  async updateDetails(
    spaceId: string,
    details: { name?: string; description?: string | null; parentOrganizationId?: string | null }
  ) {
    if (!mongoose.isValidObjectId(spaceId)) return null;
    const $set: Record<string, unknown> = {};
    if (details.name !== undefined) $set.name = details.name;
    if (details.description !== undefined) $set.description = details.description;
    if (details.parentOrganizationId !== undefined) $set.parentOrganizationId = details.parentOrganizationId;
    if (Object.keys($set).length === 0) return this.findLiveById(spaceId);
    const doc = await this.model.findOneAndUpdate(
      { _id: spaceId, deletedAt: null },
      { $set },
      { new: true, runValidators: true }
    );
    return doc?.toJSON() ?? null;
  }

  async softDelete(spaceId: string, ownerUserId: string) {
    if (!mongoose.isValidObjectId(spaceId)) return false;
    const result = await this.model.updateOne(
      { _id: spaceId, ownerUserId, deletedAt: null },
      { $set: { deletedAt: new Date() } }
    );
    return result.modifiedCount > 0;
  }
}

const SpaceMemberSchema = new Schema(
  {
    userId: { type: String, required: true },
    role: { type: String, enum: ['admin', 'member'], required: true },
    joinedVia: { type: String, enum: ['invite', 'link', 'domain'], required: true },
    joinedAt: { type: Date, required: true },
  },
  { _id: false }
);

export const SpaceSchema = new Schema<ISpaceDocument, ISpaceModel>(
  {
    name: { type: String, required: true, trim: true, maxlength: SPACE_NAME_MAX },
    description: { type: String, default: null, maxlength: SPACE_DESCRIPTION_MAX },
    ownerUserId: { type: String, required: true },
    members: { type: [SpaceMemberSchema], default: [] },
    removedUserIds: { type: [String], default: [] },
    parentOrganizationId: { type: String },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, getters: true },
    toObject: { virtuals: true, getters: true },
  }
);

SpaceSchema.plugin(softDeletePlugin);

SpaceSchema.index({ 'members.userId': 1 }, { name: 'space_members_user' });
SpaceSchema.index({ ownerUserId: 1, deletedAt: 1 }, { name: 'space_owner_live' });
SpaceSchema.index(
  { parentOrganizationId: 1 },
  { name: 'space_parent_org', partialFilterExpression: { parentOrganizationId: { $exists: true } } }
);

export const Space =
  (mongoose.models.Space as unknown as ISpaceModel) ?? model<ISpaceDocument, ISpaceModel>('Space', SpaceSchema);

export const spaceRepository = new SpaceRepository(Space);

export default Space;
