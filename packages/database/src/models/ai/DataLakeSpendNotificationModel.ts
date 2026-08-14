import mongoose, { Model, Schema } from 'mongoose';
import type {
  ClaimSpendNotificationInput,
  DataLakeSpendNotificationKind,
  DataLakeSpendNotificationScope,
  IDataLakeSpendNotificationDocument,
  IDataLakeSpendNotificationRepository,
} from '@bike4mind/common';
import {
  DATA_LAKE_SPEND_NOTIFICATION_KINDS,
  DATA_LAKE_SPEND_NOTIFICATION_RETENTION_DAYS,
  DATA_LAKE_SPEND_NOTIFICATION_SCOPES,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'DataLakeSpendNotification';

interface IDataLakeSpendNotificationModel extends Model<IDataLakeSpendNotificationDocument> {}

/**
 * One row per notice sent about a lake's embedding spend (#1677). The unique compound index
 * below is the entire dedup mechanism - `claimNotification` is an atomic upsert whose "did I
 * win" signal is that index rejecting a second writer, never a check-then-insert. See
 * DataLakeSpendNotificationTypes.ts for the kind/scope vocabulary.
 */
const DataLakeSpendNotificationSchema = new Schema<IDataLakeSpendNotificationDocument>(
  {
    dataLakeId: { type: String, required: true },
    organizationId: { type: String },
    kind: { type: String, enum: DATA_LAKE_SPEND_NOTIFICATION_KINDS, required: true },
    scope: { type: String, enum: DATA_LAKE_SPEND_NOTIFICATION_SCOPES, required: true },
    periodKey: { type: String, required: true },
    thresholdPct: { type: Number },
    recipientUserIds: { type: [String], default: [] },
    recipientCount: { type: Number, default: 0 },
    deliveredCount: { type: Number, default: 0 },
    deliveryFailed: { type: Boolean, default: false },
    detail: {
      reason: { type: String },
      spentMicroUsd: { type: Number },
      budgetMicroUsd: { type: Number },
      periodHours: { type: Number },
      windowEndsAt: { type: Date },
      batchId: { type: String },
      retryable: { type: Boolean },
    },
    sentAt: { type: Date, required: true },
    // Well past the platform's max configurable period budget window (30 days), so a dedup row
    // can never be swept while its window is still open. `immutable` blocks the ordinary
    // update paths, mirroring LakeAccessEventModel's same guard.
    expiresAt: { type: Date, required: true, immutable: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// The dedup key. UNIQUENESS IS CORRECTNESS HERE, not a performance hint: the claim below is an
// upsert whose "did I win" signal is this index rejecting the second writer.
DataLakeSpendNotificationSchema.index({ dataLakeId: 1, kind: 1, scope: 1, periodKey: 1 }, { unique: true });
DataLakeSpendNotificationSchema.index({ dataLakeId: 1, sentAt: -1 });
DataLakeSpendNotificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const DataLakeSpendNotificationModel: IDataLakeSpendNotificationModel =
  (mongoose.models[ModelName] as IDataLakeSpendNotificationModel) ||
  mongoose.model<IDataLakeSpendNotificationDocument, IDataLakeSpendNotificationModel>(
    ModelName,
    DataLakeSpendNotificationSchema
  );

class DataLakeSpendNotificationRepository
  extends BaseRepository<IDataLakeSpendNotificationDocument>
  implements IDataLakeSpendNotificationRepository
{
  constructor(private notificationModel: mongoose.Model<IDataLakeSpendNotificationDocument>) {
    super(notificationModel);
  }

  async claimNotification(input: ClaimSpendNotificationInput): Promise<{ claimed: boolean; id?: string }> {
    const { dataLakeId, kind, scope, periodKey } = input;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + DATA_LAKE_SPEND_NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    try {
      // includeResultMetadata surfaces lastErrorObject.upserted, which mongo sets ONLY when this
      // call performed the insert - a matched (already-claimed) update leaves it undefined. That
      // one round trip replaces the old findOneAndUpdate-then-findOne pair.
      const result = await this.notificationModel.findOneAndUpdate(
        { dataLakeId, kind, scope, periodKey },
        {
          $setOnInsert: {
            dataLakeId,
            kind,
            scope,
            periodKey,
            organizationId: input.organizationId ?? undefined,
            thresholdPct: input.thresholdPct,
            detail: input.detail,
            recipientUserIds: [],
            recipientCount: 0,
            deliveredCount: 0,
            deliveryFailed: false,
            sentAt: now,
            expiresAt,
          },
        },
        { upsert: true, includeResultMetadata: true }
      );
      const upsertedId = result.lastErrorObject?.upserted;
      if (!upsertedId) return { claimed: false };
      return { claimed: true, id: String(upsertedId) };
    } catch (err) {
      // E11000: lost the insert race to a concurrent claimer between our filter match and insert.
      if ((err as { code?: number }).code === 11000) return { claimed: false };
      throw err;
    }
  }

  async markDelivered(
    id: string,
    result: { recipientUserIds: string[]; deliveredCount: number; deliveryFailed: boolean }
  ): Promise<void> {
    await this.notificationModel.updateOne(
      { _id: id },
      {
        $set: {
          recipientUserIds: result.recipientUserIds,
          recipientCount: result.recipientUserIds.length,
          deliveredCount: result.deliveredCount,
          deliveryFailed: result.deliveryFailed,
        },
      }
    );
  }

  async deleteForLake(dataLakeId: string, scope: DataLakeSpendNotificationScope): Promise<number> {
    const result = await this.notificationModel.deleteMany({ dataLakeId, scope });
    return result.deletedCount ?? 0;
  }

  async listRecentForLake(dataLakeId: string, limit: number = 20): Promise<IDataLakeSpendNotificationDocument[]> {
    return this.notificationModel.find({ dataLakeId }).sort({ sentAt: -1 }).limit(limit);
  }
}

export const dataLakeSpendNotificationRepository = new DataLakeSpendNotificationRepository(
  DataLakeSpendNotificationModel
);
export type { DataLakeSpendNotificationKind, DataLakeSpendNotificationScope };
