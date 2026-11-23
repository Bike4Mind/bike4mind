import mongoose from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import {
  LAKE_CONFIG_SNAPSHOT_KINDS,
  type ILakeConfigSnapshot,
  type ILakeConfigSnapshotDocument,
  type ILakeConfigSnapshotRepository,
} from '@bike4mind/common';

// The full values a History row must not carry (see LakeConfigSnapshotTypes.ts). Short-lived on
// purpose: config events are kept for years, so a feed token must never be copied into one.

const LakeConfigSnapshotSchema = new mongoose.Schema(
  {
    dataLakeId: { type: String, required: true },
    eventId: { type: String, required: true },
    kind: { type: String, enum: LAKE_CONFIG_SNAPSHOT_KINDS, required: true },
    config: { type: mongoose.Schema.Types.Mixed },
    feedUrlBefore: { type: String, default: undefined },
    feedUrlAfter: { type: String, default: undefined },
    // Per-document `expiresAt` so widening the window later is a data change, not an index migration.
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// One snapshot per event. This index also serves the lookup, which leads with the lake.
LakeConfigSnapshotSchema.index({ dataLakeId: 1, eventId: 1 }, { unique: true });
// TTL sweep is storage hygiene only; `findLive` filters `expiresAt` itself.
LakeConfigSnapshotSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const LakeConfigSnapshotModel: mongoose.Model<ILakeConfigSnapshotDocument> =
  (mongoose.models['LakeConfigSnapshot'] as unknown as mongoose.Model<ILakeConfigSnapshotDocument>) ||
  mongoose.model<ILakeConfigSnapshotDocument>('LakeConfigSnapshot', LakeConfigSnapshotSchema);

class LakeConfigSnapshotRepository
  extends BaseRepository<ILakeConfigSnapshotDocument>
  implements ILakeConfigSnapshotRepository
{
  constructor(private snapshotModel: mongoose.Model<ILakeConfigSnapshotDocument>) {
    super(snapshotModel);
  }

  async record(input: ILakeConfigSnapshot): Promise<ILakeConfigSnapshotDocument> {
    const created = await this.snapshotModel.create(input);
    return created.toJSON() as ILakeConfigSnapshotDocument;
  }

  async findLive(
    dataLakeId: string,
    eventId: string,
    asOf: Date = new Date()
  ): Promise<ILakeConfigSnapshotDocument | null> {
    const doc = await this.snapshotModel.findOne({ dataLakeId, eventId, expiresAt: { $gt: asOf } });
    return (doc?.toJSON() as ILakeConfigSnapshotDocument) ?? null;
  }

  async deleteForLake(dataLakeId: string): Promise<number> {
    const { deletedCount } = await this.snapshotModel.deleteMany({ dataLakeId });
    return deletedCount ?? 0;
  }
}

export const lakeConfigSnapshotRepository = new LakeConfigSnapshotRepository(LakeConfigSnapshotModel);
