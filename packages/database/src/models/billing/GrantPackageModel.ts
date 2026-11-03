import mongoose, { Schema, model, Types } from 'mongoose';
import {
  grantPackageDay,
  type CreateGrantPackageInput,
  type GrantPackageReservation,
  type PaginatedResponse,
  type UpdateGrantPackageInput,
  type IGrantPackage,
  type IGrantPackageDocument,
  type IGrantPackageRepository,
} from '@bike4mind/common';
import { User } from '../auth/UserModel';

const GrantPackageSchema = new Schema<IGrantPackage>(
  {
    name: { type: String, required: true, trim: true },
    credits: { type: Number, required: true, min: 0 },
    storageMb: { type: Number, default: null },
    tags: { type: [String], default: [] },
    totalCap: { type: Number, default: null },
    dailyCap: { type: Number, default: null },
    redeemedTotal: { type: Number, default: 0 },
    capHits: { type: Number, default: 0 },
    lastCapHitAt: { type: Date, default: null },
    active: { type: Boolean, default: true },
    createdBy: { type: String, required: true },
    reason: { type: String, default: null },
  },
  { timestamps: true }
);

GrantPackageSchema.index({ active: 1, createdAt: -1 });

export const GrantPackage: mongoose.Model<IGrantPackage> =
  (mongoose.models.GrantPackage as mongoose.Model<IGrantPackage> | undefined) ??
  model<IGrantPackage>('GrantPackage', GrantPackageSchema);

export interface IGrantPackageRedemption {
  packageId: string;
  userId: string;
  day: string;
  /** Whether this redemption was counted against the day's cap, so a release only undoes what it took. */
  dayCounted: boolean;
}

const GrantPackageRedemptionSchema = new Schema<IGrantPackageRedemption>(
  {
    packageId: { type: String, required: true },
    userId: { type: String, required: true },
    day: { type: String, required: true },
    dayCounted: { type: Boolean, required: true },
  },
  { timestamps: true }
);

GrantPackageRedemptionSchema.index({ packageId: 1, userId: 1 }, { unique: true });

export const GrantPackageRedemption: mongoose.Model<IGrantPackageRedemption> =
  (mongoose.models.GrantPackageRedemption as mongoose.Model<IGrantPackageRedemption> | undefined) ??
  model<IGrantPackageRedemption>('GrantPackageRedemption', GrantPackageRedemptionSchema);

export interface IGrantPackageDayCount {
  packageId: string;
  day: string;
  count: number;
}

const GrantPackageDayCountSchema = new Schema<IGrantPackageDayCount>(
  {
    packageId: { type: String, required: true },
    day: { type: String, required: true },
    count: { type: Number, default: 0 },
  },
  { timestamps: true }
);

GrantPackageDayCountSchema.index({ packageId: 1, day: 1 }, { unique: true });

export const GrantPackageDayCount: mongoose.Model<IGrantPackageDayCount> =
  (mongoose.models.GrantPackageDayCount as mongoose.Model<IGrantPackageDayCount> | undefined) ??
  model<IGrantPackageDayCount>('GrantPackageDayCount', GrantPackageDayCountSchema);

const toDocument = (doc: IGrantPackage & { _id: unknown }): IGrantPackageDocument => {
  const { _id, ...rest } = doc as IGrantPackage & { _id: unknown; __v?: number };
  delete (rest as { __v?: number }).__v;
  return { ...rest, id: String(_id) };
};

export class GrantPackageRepository implements IGrantPackageRepository {
  async findById(id: string): Promise<IGrantPackageDocument | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await GrantPackage.findById(id).lean();
    return doc ? toDocument(doc) : null;
  }

  /** Newest first, each with how many redemptions today's daily cap has counted. */
  async listPackages({
    page,
    limit,
    now = new Date(),
  }: {
    page: number;
    limit: number;
    now?: Date;
  }): Promise<PaginatedResponse<IGrantPackageDocument & { redeemedToday: number }>> {
    const [docs, total] = await Promise.all([
      GrantPackage.find()
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      GrantPackage.countDocuments(),
    ]);
    const ids = docs.map(doc => String(doc._id));
    const dayCounts = await GrantPackageDayCount.find({ packageId: { $in: ids }, day: grantPackageDay(now) }).lean();
    const today = new Map(dayCounts.map(row => [row.packageId, row.count]));
    return {
      data: docs.map(doc => ({ ...toDocument(doc), redeemedToday: today.get(String(doc._id)) ?? 0 })),
      meta: { currentPage: page, totalPages: Math.ceil(total / limit), total },
    };
  }

  async create(input: CreateGrantPackageInput & { createdBy: string; reason?: string | null }) {
    const [doc] = await GrantPackage.create([input]);
    return toDocument(doc.toObject());
  }

  async update(id: string, patch: UpdateGrantPackageInput & { reason?: string | null }) {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await GrantPackage.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true }).lean();
    return doc ? toDocument(doc) : null;
  }

  async reserveRedemption(packageId: string, userId: string, now: Date = new Date()): Promise<GrantPackageReservation> {
    if (!Types.ObjectId.isValid(packageId)) return { outcome: 'refused', reason: 'inactive' };
    if (await GrantPackageRedemption.exists({ packageId, userId })) {
      return { outcome: 'already', release: async () => {} };
    }
    const pkg = await GrantPackage.findById(packageId).lean();
    if (!pkg || !pkg.active) return { outcome: 'refused', reason: 'inactive' };

    const day = grantPackageDay(now);
    const dayCounted = pkg.dailyCap !== null && pkg.dailyCap !== undefined;
    if (dayCounted) {
      // Upsert first, then a conditional $inc: a conditional upsert would raise a duplicate-key
      // error at the cap, and that error aborts the caller's transaction.
      await GrantPackageDayCount.updateOne({ packageId, day }, { $setOnInsert: { count: 0 } }, { upsert: true });
      const counted = await GrantPackageDayCount.updateOne(
        { packageId, day, count: { $lt: pkg.dailyCap } },
        { $inc: { count: 1 } }
      );
      if (counted.modifiedCount !== 1) {
        await this.recordCapHit(packageId, now);
        return { outcome: 'refused', reason: 'daily_cap' };
      }
    }

    const counted = await GrantPackage.updateOne(
      { _id: packageId, active: true, $or: [{ totalCap: null }, { $expr: { $lt: ['$redeemedTotal', '$totalCap'] } }] },
      { $inc: { redeemedTotal: 1 } }
    );
    if (counted.modifiedCount !== 1) {
      if (dayCounted) await GrantPackageDayCount.updateOne({ packageId, day }, { $inc: { count: -1 } });
      await this.recordCapHit(packageId, now);
      return { outcome: 'refused', reason: 'total_cap' };
    }

    await GrantPackageRedemption.create([{ packageId, userId, day, dayCounted }]);
    return { outcome: 'reserved', release: () => this.releaseRedemption(packageId, userId) };
  }

  async releaseRedemption(packageId: string, userId: string): Promise<void> {
    const row = await GrantPackageRedemption.findOneAndDelete({ packageId, userId }).lean();
    if (!row) return;
    await GrantPackage.updateOne({ _id: packageId, redeemedTotal: { $gt: 0 } }, { $inc: { redeemedTotal: -1 } });
    if (row.dayCounted) {
      await GrantPackageDayCount.updateOne({ packageId, day: row.day, count: { $gt: 0 } }, { $inc: { count: -1 } });
    }
  }

  async isInboxClaimed(canonicalEmail: string): Promise<boolean> {
    return Boolean(await User.exists({ freeCreditClaimEmail: canonicalEmail }));
  }

  // An explicit null session opts out of the ambient transaction: the refused signup rolls back,
  // and the admin still needs to see that the cap was hit.
  private async recordCapHit(packageId: string, now: Date): Promise<void> {
    await GrantPackage.updateOne(
      { _id: packageId },
      { $inc: { capHits: 1 }, $set: { lastCapHitAt: now } },
      // mongoose types `session` without null; the runtime checks only that the key is present.
      { session: null as unknown as undefined }
    );
  }
}

export const grantPackageRepository = new GrantPackageRepository();
