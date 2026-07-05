import { FriendshipStatus, IFriendshipDocument, IFriendshipModelAdapter } from '@bike4mind/common';
import mongoose from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

interface IFriendshipModel extends mongoose.Model<IFriendshipDocument> {}

export const FriendshipSchema = new mongoose.Schema<IFriendshipDocument, IFriendshipModel>(
  {
    requester: { type: String, ref: 'User', required: true },
    recipient: { type: String, ref: 'User', required: true },
    status: { type: String, enum: Object.values(FriendshipStatus), required: true },
    message: { type: String },
  },
  {
    virtuals: true,
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
    timestamps: true,
  }
);

// Make sure that a friendship between two users is unique (no duplicates)
FriendshipSchema.index({ requester: 1, recipient: 1 }, { unique: true });

export const Friendship =
  (mongoose.models.Friendship as unknown as IFriendshipModel) ??
  mongoose.model<IFriendshipDocument, IFriendshipModel>('Friendship', FriendshipSchema);

class FriendshipRepository extends BaseRepository<IFriendshipDocument> implements IFriendshipModelAdapter {
  constructor(model: IFriendshipModel) {
    super(model);
  }

  async deleteById(id: string) {
    await this.model.findByIdAndDelete(id);
  }

  async findByUsers(userId1: string, userId2: string) {
    return this.model.findOne({
      $or: [
        { requester: userId1, recipient: userId2 },
        { requester: userId2, recipient: userId1 },
      ],
    });
  }

  async updateStatus(id: string, status: FriendshipStatus) {
    const friendship = await this.model.findByIdAndUpdate(id, { status }, { new: true });
    if (!friendship) throw new Error('Friendship not found');
    return friendship;
  }

  async deleteByUsers(userId1: string, userId2: string) {
    await this.model.deleteOne({
      $or: [
        { requester: userId1, recipient: userId2 },
        { requester: userId2, recipient: userId1 },
      ],
    });
  }

  async findAllForUser(userId: string, options: { status?: FriendshipStatus | FriendshipStatus[] } = {}) {
    const query: mongoose.FilterQuery<IFriendshipDocument> = {
      $or: [{ requester: userId }, { recipient: userId }],
    };

    if (options.status) {
      query.status = Array.isArray(options.status) ? { $in: options.status } : options.status;
    }

    return this.model.find(query);
  }
}

export const friendshipRepository = new FriendshipRepository(Friendship);
