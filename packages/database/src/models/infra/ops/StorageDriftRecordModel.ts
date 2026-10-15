import mongoose, { Model, Schema, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import { IStorageDriftRecord, IStorageDriftRecordDocument, IStorageDriftRecordRepository } from '@bike4mind/common';

// One row per user per reconciliation pass, so retention is bounded by a TTL rather than growing with
// the user count forever.
const RETENTION_SECONDS = 30 * 24 * 60 * 60;

const StorageDriftRecordSchema = new Schema<IStorageDriftRecordDocument>(
  {
    userId: { type: String, required: true },
    counter: { type: Number, required: true },
    truth: { type: Number, required: true },
    drift: { type: Number, required: true },
    repaired: { type: Boolean, required: true },
    conflict: { type: Boolean, required: true },
    checkedAt: { type: Date, required: true },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

StorageDriftRecordSchema.index({ checkedAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });
StorageDriftRecordSchema.index({ userId: 1, checkedAt: -1 });

export type IStorageDriftRecordModel = Model<IStorageDriftRecordDocument>;

export class StorageDriftRecordRepository
  extends BaseRepository<IStorageDriftRecordDocument>
  implements IStorageDriftRecordRepository
{
  constructor(model: IStorageDriftRecordModel) {
    super(model);
  }

  async appendMany(records: IStorageDriftRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.model.insertMany(records, { ordered: false });
  }

  async latestByUserIds(userIds: string[]): Promise<Map<string, IStorageDriftRecord>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.model.aggregate<{ _id: string; doc: IStorageDriftRecord }>([
      { $match: { userId: { $in: userIds } } },
      { $sort: { userId: 1, checkedAt: -1 } },
      { $group: { _id: '$userId', doc: { $first: '$$ROOT' } } },
    ]);
    return new Map(rows.map(row => [row._id, row.doc]));
  }
}

export const StorageDriftRecord =
  (mongoose.models['StorageDriftRecord'] as unknown as IStorageDriftRecordModel) ??
  model<IStorageDriftRecordDocument>('StorageDriftRecord', StorageDriftRecordSchema);
export const storageDriftRecordRepository = new StorageDriftRecordRepository(StorageDriftRecord);
