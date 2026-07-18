import mongoose, { Schema } from 'mongoose';
import { IGroupShare, IShareableStaticMethods, IUserDocument, IUserShare, Permission } from '@bike4mind/common';

export const GroupShareableSchema = new Schema<IGroupShare>({
  groupId: { type: String, required: true },
  permissions: {
    type: [String],
    enum: Object.keys(Permission),
    required: true,
  },
});

export const UserShareableSchema = new Schema<IUserShare>(
  {
    userId: { type: String, required: true },
    permissions: {
      type: [String],
      enum: Object.keys(Permission),
      required: true,
    },
    projectId: { type: String, required: false },

    extraData: {
      type: Map,
      of: Schema.Types.Mixed,
    },
  },
  {
    _id: false,
    id: false,
    versionKey: false,
  }
);

UserShareableSchema.virtual('user', {
  ref: 'User',
  localField: 'userId',
  foreignField: '_id',
  justOne: true,
});

// Basic stub for sharing files and tools.
export const ShareableDocumentSchema = {
  isGlobalRead: { type: Boolean, default: false },
  isGlobalWrite: { type: Boolean, default: false },
  groups: {
    type: [GroupShareableSchema],
    default: [],
  },
  users: {
    type: [UserShareableSchema],
    default: [],
  },
};

export class ShareableDocumentRepository<T> implements IShareableStaticMethods<T> {
  private model: mongoose.Model<T>;

  constructor(model: mongoose.Model<T>) {
    this.model = model;
  }

  async findAllAccessible(user: IUserDocument): Promise<T[]> {
    return this.model.find({
      $or: [
        { userId: user.id },
        { users: { $elemMatch: { userId: user.id, permissions: { $in: ['read', 'write'] } } } },
        { groups: { $elemMatch: { groupId: { $in: user.groups }, permissions: { $in: ['read', 'write'] } } } },
      ],
    });
  }

  async findAllShared(user: IUserDocument): Promise<T[]> {
    return this.model.find({
      $or: [
        { users: { $elemMatch: { userId: user.id, permissions: { $in: ['read', 'write'] } } } },
        { groups: { $elemMatch: { groupId: { $in: user.groups }, permissions: { $in: ['read', 'write'] } } } },
      ],
    });
  }

  async findAllAccessibleByIds(user: IUserDocument, ids: string[]): Promise<T[]> {
    return this.model.where({
      _id: { $in: ids },
      $or: [
        { userId: user.id },
        { users: { $elemMatch: { userId: user.id, permissions: { $in: ['read', 'write'] } } } },
        { groups: { $elemMatch: { groupId: { $in: user.groups }, permissions: { $in: ['read', 'write'] } } } },
      ],
    });
  }

  async findAccessibleById(user: Pick<IUserDocument, 'id' | 'groups'>, id: string): Promise<T | null> {
    const doc = await this.model.findOne({
      _id: id,
      $or: [
        {
          userId: user.id,
        },
        {
          users: {
            $elemMatch: {
              userId: user.id,
              permissions: { $in: ['read', 'write'] },
            },
          },
        },
        {
          groups: {
            $elemMatch: {
              groupId: { $in: user.groups },
              permissions: { $in: ['read', 'write'] },
            },
          },
        },
      ],
    });

    return doc?.toJSON() as T | null;
  }

  async findUpdateAccessById(user: Pick<IUserDocument, 'id' | 'groups'>, id: string): Promise<T | null> {
    return this.model.findOne({
      _id: { $in: id },
      $or: [
        { userId: user.id },
        { users: { $elemMatch: { userId: user.id, permissions: { $in: ['update'] } } } },
        { groups: { $elemMatch: { groupId: { $in: user.groups }, permissions: { $in: ['update'] } } } },
      ],
    });
  }

  async findShareAccessById(user: Pick<IUserDocument, 'id' | 'groups'>, id: string): Promise<T | null> {
    return this.model.findOne({
      _id: id,
      // Own / users-share / groups-share, mirroring the CASL `Permission.share` arms
      // in ability.ts (own, users[].share, groups[].share) and matching the sibling
      // findAccessById / findUpdateAccessById statics, which both include the groups arm.
      $or: [
        { userId: user.id },
        { users: { $elemMatch: { userId: user.id, permissions: { $in: ['share'] } } } },
        { groups: { $elemMatch: { groupId: { $in: user.groups }, permissions: { $in: ['share'] } } } },
      ],
    });
  }
}

export type { IShareableDocument, IGroupShare } from '@bike4mind/common';
