import { IInboxDocument, InboxType, IInboxRepository, SAFE_USER_LOOKUP_PROJECT } from '@bike4mind/common';
import mongoose, { PipelineStage } from 'mongoose';
import { softDeletePlugin } from '../../utils/mongo';
import BaseRepository from '@bike4mind/db-core';

export interface IInboxObject extends IInboxDocument {
  toJSON: () => IInboxDocument;
}

export interface IInboxModel extends mongoose.Model<IInboxDocument> {}

const InboxSchema = new mongoose.Schema<IInboxObject>(
  {
    userId: { type: String, required: true },
    receiverId: { type: String, required: true },
    type: { type: String, required: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    readAt: { type: Date, default: null },
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

InboxSchema.plugin(softDeletePlugin);

export const Inbox: IInboxModel =
  mongoose.models.Inbox ?? mongoose.model<IInboxObject, IInboxModel>('Inbox', InboxSchema);

class InboxRepository extends BaseRepository<IInboxDocument> implements IInboxRepository {
  constructor(model: IInboxModel) {
    super(model);
  }

  async findByReceiverId(receiverId: string, options?: { sort?: Record<string, unknown> }): Promise<IInboxDocument[]> {
    const pipeline: PipelineStage[] = [
      // Exclude soft-deleted items
      { $match: { receiverId, deletedAt: null } },

      // Convert stage: $convert with onError handles non-ObjectId values like 'SYSTEM'
      {
        $addFields: {
          userIdAsObjectId: { $convert: { input: '$userId', to: 'objectId', onError: null } },
        },
      },

      // Aggregation $lookup bypasses Mongoose `select:false`, so a bare lookup
      // would attach the full sender user doc. Project off the shared secret-free
      // baseline (SAFE_USER_LOOKUP_PROJECT) plus the extra non-secret fields the
      // inbox SenderInfoModal reads (email/phone/createdAt). Never add credential/
      // secret fields here. Keep in sync with the SenderInfoModal consumer.
      {
        $lookup: {
          from: 'users',
          let: { senderId: '$userIdAsObjectId' },
          pipeline: [
            { $match: { $expr: { $eq: ['$_id', '$$senderId'] } } },
            {
              $project: {
                ...SAFE_USER_LOOKUP_PROJECT,
                // Expose the string id the SenderInfoModal reads (sender.id); an
                // aggregation result has no Mongoose `id` virtual, only `_id`.
                id: { $toString: '$_id' },
                email: 1,
                phone: 1,
                createdAt: 1,
              },
            },
          ],
          as: 'sender',
        },
      },

      {
        $addFields: {
          sender: { $arrayElemAt: ['$sender', 0] },
        },
      },

      {
        $match: {
          $or: [{ userId: 'SYSTEM' }, { 'sender._id': { $exists: true } }],
        },
      },
    ];

    if (options?.sort) {
      pipeline.push({ $sort: options.sort as unknown as Record<string, 1 | -1> });
    }

    const result = await this.model.aggregate(pipeline);
    // Filter out documents with null _id to prevent toString() errors
    return result.filter(d => d._id != null).map(d => ({ ...d, id: d._id.toString() }));
  }

  async markAsRead(ids: string[], receiverId?: string): Promise<void> {
    const filter: Record<string, unknown> = { _id: { $in: ids } };
    if (receiverId) {
      filter.receiverId = receiverId;
    }
    const query = this.model.updateMany(filter, { $set: { readAt: new Date() } });
    // Only attach an explicit session when one is set; .session(null) overrides
    // transactionAsyncLocalStorage propagation and silently breaks atomicity.
    if (this._txn) {
      query.session(this._txn);
    }
    await query;
  }

  async createInboxMessage(data: {
    userId: string;
    receiverId: string;
    title: string;
    message: string;
    type: InboxType;
  }): Promise<IInboxDocument> {
    const result = await this.model.create(data);
    return result.toJSON();
  }

  async deleteByReceiverId(receiverId: string, messageId: string): Promise<boolean> {
    const query = this.model.findOneAndUpdate(
      { _id: messageId, receiverId },
      { $set: { deletedAt: new Date() } },
      { new: true }
    );
    // Only attach an explicit session when one is set; .session(null) overrides
    // transactionAsyncLocalStorage propagation and silently breaks atomicity.
    if (this._txn) {
      query.session(this._txn);
    }
    const result = await query;
    return !!result;
  }
}

export const inboxRepository = new InboxRepository(Inbox);
export default Inbox;
