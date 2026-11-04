import {
  IRegInviteDocument,
  IRegistrationInvite,
  IRegistrationInviteRepository,
  RegInviteSource,
  RegInviteStatusType,
} from '@bike4mind/common';
import mongoose from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

interface IRegistrationInviteModel extends mongoose.Model<IRegInviteDocument> {}

export class RegistrationInviteRepository
  extends BaseRepository<IRegInviteDocument>
  implements IRegistrationInviteRepository
{
  constructor(protected model: IRegistrationInviteModel) {
    super(model);
    this.model = model;
  }

  async findByCode(code: string) {
    return this.model.findOne({ code });
  }
  async createMany(invites: Omit<IRegInviteDocument, 'id'>[]) {
    return this.model.insertMany(invites);
  }
  async deleteByIds(ids: string[]) {
    await this.model.deleteMany({ _id: { $in: ids } });
  }
  async findAll() {
    const result = await this.model.find({});
    return result.map(r => r.toJSON());
  }

  async formatRegInvites(updates: Partial<IRegistrationInvite>, ids: string[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inviteParams: { $set: any; $unset: any } = { $set: updates, $unset: { used: 1 } };
    if (!updates.status) {
      inviteParams.$set = updates;
      delete inviteParams.$unset;
    } else {
      if (updates.status === RegInviteStatusType.used) {
        inviteParams.$set['used'] = new Date();
        delete inviteParams.$unset;
      }
    }

    await this.model.updateMany({ _id: { $in: ids } }, inviteParams);
    const updatedInvites = await this.find({ _id: { $in: ids } });

    return updatedInvites;
  }

  /**
   * Per-package code counts for the grant packages admin list. A code is active while it is
   * unexpired and still redeemable (open, or unlimited-use). nextExpiry is the soonest expiry
   * among active codes that carry one.
   */
  async usageByGrantPackage(ids: string[], now: Date = new Date()) {
    const usage = new Map<string, { codes: number; activeCodes: number; nextExpiry: Date | null }>();
    if (ids.length === 0) return usage;

    const active = {
      $and: [
        { $or: [{ $eq: [{ $ifNull: ['$expiresAt', null] }, null] }, { $gt: ['$expiresAt', now] }] },
        { $or: [{ $eq: ['$status', RegInviteStatusType.open] }, { $eq: ['$unlimitedUse', true] }] },
      ],
    };
    const rows = await this.model.aggregate<{
      _id: string;
      codes: number;
      activeCodes: number;
      nextExpiry: Date | null;
    }>([
      { $match: { grantPackageId: { $in: ids } } },
      {
        $group: {
          _id: '$grantPackageId',
          codes: { $sum: 1 },
          activeCodes: { $sum: { $cond: [active, 1, 0] } },
          // $min skips null, so codes without an expiry (or inactive ones) never win.
          nextExpiry: { $min: { $cond: [active, { $ifNull: ['$expiresAt', null] }, null] } },
        },
      },
    ]);
    for (const row of rows) {
      usage.set(row._id, { codes: row.codes, activeCodes: row.activeCodes, nextExpiry: row.nextExpiry ?? null });
    }
    return usage;
  }
}

const RegistrationInviteSchema = new mongoose.Schema<IRegInviteDocument>(
  {
    status: {
      type: String,
      required: true,
    },
    userId: {
      type: String,
      required: true,
      unique: false,
    },
    usedbyId: {
      type: String,
      required: false,
      unique: false,
    },
    code: {
      type: String,
      required: true,
      unique: true,
    },
    email: {
      type: String,
      required: false,
      // No unique constraint - DocumentDB doesn't handle sparse indexes like MongoDB.
      // Email uniqueness is handled at application level when needed.
    },
    title: {
      type: String,
      required: false,
    },
    description: {
      type: String,
      required: false,
    },
    expiresAt: {
      type: Date,
      required: false,
    },
    used: {
      type: Date,
      required: false,
    },
    source: {
      type: String,
      enum: Object.values(RegInviteSource),
      required: false,
    },
    unlimitedUse: {
      type: Boolean,
      required: false,
      default: false,
    },
    usageHistory: {
      type: [
        {
          userId: { type: String, required: true },
          usedAt: { type: Date, required: true },
        },
      ],
      required: false,
      default: [],
    },
    tags: {
      type: [String],
      required: false,
      default: [],
    },
    startingCredits: {
      type: Number,
      required: false,
    },
    startingStorage: {
      type: Number,
      required: false,
    },
    grantPackageId: {
      type: String,
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

// No index on email field - DocumentDB doesn't properly support sparse unique indexes.
// The 'code' field ensures uniqueness for each invite.

export const RegistrationInvite =
  (mongoose.models.RegistrationInvite as IRegistrationInviteModel) ??
  mongoose.model<IRegInviteDocument, IRegistrationInviteModel>('RegistrationInvite', RegistrationInviteSchema);

export const registrationInviteRepository = new RegistrationInviteRepository(RegistrationInvite);
