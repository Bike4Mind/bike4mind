import mongoose, { Model, Schema, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import { IStorageDriftRecord, IStorageDriftRecordDocument, IStorageDriftRecordRepository } from '@bike4mind/common';

// One row per owner (user or organization) per reconciliation pass, so retention is bounded by a TTL rather than growing with
// the owner count forever.
const RETENTION_SECONDS = 30 * 24 * 60 * 60;

const StorageDriftRecordSchema = new Schema<IStorageDriftRecordDocument>(
  {
    userId: { type: String },
    organizationId: { type: String },
    counter: { type: Number, required: true },
    truth: { type: Number, required: true },
    drift: { type: Number, required: true },
    repaired: { type: Boolean, required: true },
    conflict: { type: Boolean, required: true },
    checkedAt: { type: Date, required: true },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

StorageDriftRecordSchema.pre('validate', function () {
  if (Boolean(this.userId) === Boolean(this.organizationId)) {
    this.invalidate('userId', 'Exactly one of userId and organizationId must be set');
  }
});

StorageDriftRecordSchema.index({ checkedAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });
StorageDriftRecordSchema.index({ userId: 1, checkedAt: -1 });
StorageDriftRecordSchema.index(
  { organizationId: 1, checkedAt: -1 },
  { partialFilterExpression: { organizationId: { $type: 'string' } } }
);

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
    await this.model.insertMany(records, { ordered: false, throwOnValidationError: true });
  }

  latestByUserIds(userIds: string[]): Promise<Map<string, IStorageDriftRecord>> {
    return this.latestByOwnerField('userId', userIds);
  }

  latestByOrganizationIds(organizationIds: string[]): Promise<Map<string, IStorageDriftRecord>> {
    return this.latestByOwnerField('organizationId', organizationIds);
  }

  private async latestByOwnerField(
    field: 'userId' | 'organizationId',
    ownerIds: string[]
  ): Promise<Map<string, IStorageDriftRecord>> {
    if (ownerIds.length === 0) return new Map();
    const rows = await this.model.aggregate<{ _id: string; doc: IStorageDriftRecord }>([
      { $match: { [field]: { $in: ownerIds } } },
      { $sort: { [field]: 1, checkedAt: -1 } },
      { $group: { _id: `$${field}`, doc: { $first: '$$ROOT' } } },
    ]);
    return new Map(rows.map(row => [row._id, row.doc]));
  }
}

export const StorageDriftRecord =
  (mongoose.models['StorageDriftRecord'] as unknown as IStorageDriftRecordModel) ??
  model<IStorageDriftRecordDocument>('StorageDriftRecord', StorageDriftRecordSchema);
export const storageDriftRecordRepository = new StorageDriftRecordRepository(StorageDriftRecord);
