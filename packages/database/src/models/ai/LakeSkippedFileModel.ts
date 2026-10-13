import mongoose from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import type {
  ILakeSkippedFileDocument,
  ILakeSkippedFileRepository,
  LakeSkippedFileInput,
  LakeSkippedFileSourceKind,
} from '@bike4mind/common';
import { LAKE_SKIPPED_FILE_REASONS, LAKE_SKIPPED_FILE_SOURCE_KINDS } from '@bike4mind/common';

// See ILakeSkippedFile (in @bike4mind/common) for the record's contract. Its own collection rather
// than a field on the batch: the list must outlive the batch, and the batch document already
// carries a size concern (driveLakeIngest.ts, `skippedDriveFileIds`).

const LakeSkippedFileSchema = new mongoose.Schema(
  {
    dataLakeId: { type: String, required: true },
    sourceKind: { type: String, enum: LAKE_SKIPPED_FILE_SOURCE_KINDS, required: true },
    sourceId: { type: String, required: true },
    name: { type: String, required: true },
    relativePath: { type: String },
    mimeType: { type: String },
    size: { type: Number },
    reason: { type: String, enum: LAKE_SKIPPED_FILE_REASONS, required: true },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

// `unique` is what makes `recordSkip` atomic on the key, so a file re-skipped on every full walk
// (or by two overlapping slices) stays exactly one row. Its leading fields also serve the
// per-source prune and clear.
LakeSkippedFileSchema.index({ dataLakeId: 1, sourceKind: 1, sourceId: 1 }, { unique: true });
LakeSkippedFileSchema.index({ dataLakeId: 1, lastSeenAt: -1 });

export const LakeSkippedFileModel =
  (mongoose.models['LakeSkippedFile'] as unknown as mongoose.Model<ILakeSkippedFileDocument>) ||
  mongoose.model<ILakeSkippedFileDocument>('LakeSkippedFile', LakeSkippedFileSchema);

class LakeSkippedFileRepository extends BaseRepository<ILakeSkippedFileDocument> implements ILakeSkippedFileRepository {
  constructor(private skippedFileModel: mongoose.Model<ILakeSkippedFileDocument>) {
    super(skippedFileModel);
  }

  async recordSkip(input: LakeSkippedFileInput): Promise<void> {
    const { dataLakeId, sourceKind, sourceId, name, relativePath, mimeType, size, reason } = input;
    const now = new Date();
    // Optional fields are $set or $unset explicitly, so a refreshed row never keeps a stale size or
    // mime type from an earlier skip of the same file.
    const optional = { relativePath, mimeType, size };
    const set = Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined));
    const unset = Object.fromEntries(
      Object.entries(optional)
        .filter(([, value]) => value === undefined)
        .map(([key]) => [key, ''])
    );
    await this.skippedFileModel.updateOne(
      { dataLakeId, sourceKind, sourceId },
      {
        $set: { name, reason, lastSeenAt: now, ...set },
        ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
        $setOnInsert: { firstSeenAt: now },
      },
      { upsert: true, runValidators: true }
    );
  }

  async clearSources(
    dataLakeId: string,
    sourceKind: LakeSkippedFileSourceKind,
    sourceIds: readonly string[]
  ): Promise<number> {
    if (sourceIds.length === 0) return 0;
    const { deletedCount } = await this.skippedFileModel.deleteMany({
      dataLakeId,
      sourceKind,
      sourceId: { $in: [...sourceIds] },
    });
    return deletedCount ?? 0;
  }

  async pruneMissing(
    dataLakeId: string,
    sourceKind: LakeSkippedFileSourceKind,
    presentSourceIds: ReadonlySet<string>
  ): Promise<number> {
    // Diff in memory against the (small) stored set rather than sending the whole walk as a $nin:
    // a large folder's id list would bloat the query, the skipped set stays a handful of rows.
    const stored: string[] = await this.skippedFileModel.distinct('sourceId', { dataLakeId, sourceKind });
    const gone = stored.filter(sourceId => !presentSourceIds.has(sourceId));
    return this.clearSources(dataLakeId, sourceKind, gone);
  }

  async listByLake(
    dataLakeId: string,
    options: { limit: number; offset: number }
  ): Promise<ILakeSkippedFileDocument[]> {
    const docs = await this.skippedFileModel
      .find({ dataLakeId })
      .sort({ lastSeenAt: -1, _id: -1 })
      .skip(options.offset)
      .limit(options.limit);
    return docs.map(doc => doc.toJSON() as ILakeSkippedFileDocument);
  }

  async countByLake(dataLakeId: string): Promise<number> {
    return this.skippedFileModel.countDocuments({ dataLakeId });
  }

  async deleteForSource(dataLakeId: string, sourceKind: LakeSkippedFileSourceKind): Promise<number> {
    const { deletedCount } = await this.skippedFileModel.deleteMany({ dataLakeId, sourceKind });
    return deletedCount ?? 0;
  }

  async deleteForLake(dataLakeId: string): Promise<number> {
    const { deletedCount } = await this.skippedFileModel.deleteMany({ dataLakeId });
    return deletedCount ?? 0;
  }
}

export const lakeSkippedFileRepository = new LakeSkippedFileRepository(LakeSkippedFileModel);
