import mongoose, { Model, model, Schema } from 'mongoose';
import {
  ISubscriberDocument,
  ISubscriberRepository,
  SUBSCRIBER_SOURCES,
  SUBSCRIBER_SUSPICIOUS_REASONS,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';

export interface ISubscriberModel extends Model<ISubscriberDocument> {}

export class SubscriberRepository extends BaseRepository<ISubscriberDocument> implements ISubscriberRepository {
  constructor(model: ISubscriberModel) {
    super(model);
  }

  async findByEmail(email: string) {
    const result = await this.model.findOne({ email: email.trim().toLowerCase() });
    return result?.toJSON() ?? null;
  }

  async listSubscribers(options: { page: number; limit: number; search?: string }) {
    const { page, limit, search } = options;
    const skip = (page - 1) * limit;

    const query = {
      deletedAt: null,
      ...(search && {
        $or: [
          { firstName: { $regex: escapeRegex(search), $options: 'i' } },
          { lastName: { $regex: escapeRegex(search), $options: 'i' } },
          { email: { $regex: escapeRegex(search), $options: 'i' } },
        ],
      }),
    };

    const [subscribers, total] = await Promise.all([
      this.model.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      this.model.countDocuments(query),
    ]);

    return {
      data: subscribers.map(doc => doc.toJSON()),
      meta: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        total,
      },
    };
  }

  async markInviteGenerated(id: string, inviteCode: string, adminId: string, credits: number, storage: number) {
    const subscriber = await this.model.findByIdAndUpdate(
      id,
      {
        $set: {
          inviteGenerated: true,
          inviteCode,
          inviteGeneratedAt: new Date(),
          inviteGeneratedBy: adminId,
          startingCredits: credits,
          startingStorage: storage,
        },
      },
      { new: true }
    );

    if (!subscriber) {
      throw new Error(`Subscriber with id ${id} not found`);
    }

    return subscriber.toJSON();
  }

  async clearSignupNetworkBefore(cutoff: Date) {
    // A retention rewrite is not a subscriber change, so it must not bump updatedAt.
    const result = await this.model.updateMany(
      { 'signupNetwork.capturedAt': { $lt: cutoff } },
      { $set: { signupNetwork: null } },
      { timestamps: false }
    );
    return result.modifiedCount;
  }

  async countWaiting() {
    return this.model.countDocuments({
      deletedAt: null,
      $or: [{ inviteGenerated: { $ne: true } }, { inviteGenerated: { $exists: false } }],
    });
  }
}

// _id: false and no defaults, so a row written before capture existed reads back without either key.
const SignupNetworkSchema = new Schema(
  {
    ipPrefix: { type: String, default: null },
    userAgent: { type: String, default: null },
    asn: { type: Number, default: null },
    asnOrg: { type: String, default: null },
    country: { type: String, default: null },
    isDatacenter: { type: Boolean, default: null },
    ja4: { type: String, default: null },
    wafAnonIp: { type: Boolean, default: null },
    wafBotSignal: { type: Boolean, default: null },
    challengeVerified: { type: Boolean, default: null },
    capturedAt: { type: Date, required: true },
  },
  { _id: false }
);

const SuspiciousSchema = new Schema(
  { reasons: { type: [{ type: String, enum: SUBSCRIBER_SUSPICIOUS_REASONS }], default: undefined } },
  { _id: false }
);

export const SubscriberSchema = new Schema<ISubscriberDocument, ISubscriberModel>(
  {
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    source: { type: String, enum: SUBSCRIBER_SOURCES, default: 'subscribe_page' },
    deletedAt: { type: Date, default: null },
    // Invite generation tracking
    inviteGenerated: { type: Boolean, default: false },
    inviteCode: { type: String, default: null },
    inviteGeneratedAt: { type: Date, default: null },
    inviteGeneratedBy: { type: String, default: null },
    startingCredits: { type: Number, default: null },
    startingStorage: { type: Number, default: null },
    signupNetwork: { type: SignupNetworkSchema, default: undefined },
    suspicious: { type: SuspiciousSchema, default: undefined },
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

SubscriberSchema.index({ deletedAt: 1 });
SubscriberSchema.index({ createdAt: -1 });
SubscriberSchema.index({ inviteGenerated: 1 });

export const Subscriber =
  (mongoose.models.Subscriber as unknown as ISubscriberModel) ??
  model<ISubscriberDocument, ISubscriberModel>('Subscriber', SubscriberSchema);

export const subscriberRepository = new SubscriberRepository(Subscriber);

export default Subscriber;
