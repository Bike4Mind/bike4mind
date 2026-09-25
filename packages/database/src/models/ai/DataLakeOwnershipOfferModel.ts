import mongoose, { Schema } from 'mongoose';
import type {
  DataLakeOwnershipOfferStatus,
  IDataLakeOwnershipOfferDocument,
  IDataLakeOwnershipOfferRepository,
} from '@bike4mind/common';
import { DATA_LAKE_OWNERSHIP_OFFER_RUNGS, DATA_LAKE_OWNERSHIP_OFFER_STATUSES } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'DataLakeOwnershipOffer';

/**
 * "Still open at `asOf`" filter fragment, shared by every pending read so the expiry rule cannot
 * drift between them. An offer is live when it is `pending` AND (no expiry OR expiry strictly after
 * `asOf`). Returns an empty fragment when `asOf` is omitted - callers that want the raw pending set
 * (resolution, an audit read) pass nothing. Per-arm null/'' form for DocumentDB safety, matching the
 * grant model's `buildActiveGrantFilter`.
 */
export const buildPendingOfferExpiryFilter = (asOf?: Date): Record<string, unknown> =>
  asOf ? { $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gt: asOf } }] } : {};

const DataLakeOwnershipOfferSchema = new Schema<IDataLakeOwnershipOfferDocument>(
  {
    dataLakeId: { type: String, required: true },
    organizationId: { type: String },
    offeredByUserId: { type: String, required: true },
    recipientUserId: { type: String, required: true },
    // Mutable `string[]` wants the spread of the `as const` tuple (so Zod can build a literal union
    // from the same source array). One vocabulary, two layers - same pattern as the grant model.
    status: { type: String, enum: [...DATA_LAKE_OWNERSHIP_OFFER_STATUSES], required: true },
    expiresAt: { type: Date, required: true },
    resolvedAt: { type: Date },
    priorOwnerUserIds: { type: [String], default: [] },
    offeredVia: { type: String, enum: [...DATA_LAKE_OWNERSHIP_OFFER_RUNGS], required: true },
    auditPrincipal: {
      principalKind: { type: String, enum: ['user', 'apiKey', 'system'] },
      principalId: { type: String },
      onBehalfOfUserId: { type: String },
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// At most one live offer per lake. A PARTIAL unique index (not `unique: true` on the field): a lake
// may legitimately accumulate resolved offers over its life, so the invariant is "one PENDING", not
// "one ever". A concurrent second offer hits this index and is refused rather than silently queued.
DataLakeOwnershipOfferSchema.index({ dataLakeId: 1 }, { unique: true, partialFilterExpression: { status: 'pending' } });
// The recipient's pending-offer list.
DataLakeOwnershipOfferSchema.index({ recipientUserId: 1, status: 1 });

export const DataLakeOwnershipOfferModel =
  (mongoose.models[ModelName] as unknown as mongoose.Model<IDataLakeOwnershipOfferDocument>) ||
  mongoose.model<IDataLakeOwnershipOfferDocument>(ModelName, DataLakeOwnershipOfferSchema);

class DataLakeOwnershipOfferRepository
  extends BaseRepository<IDataLakeOwnershipOfferDocument>
  implements IDataLakeOwnershipOfferRepository
{
  constructor(private offerModel: mongoose.Model<IDataLakeOwnershipOfferDocument>) {
    super(offerModel);
  }

  async findPendingForLake(dataLakeId: string, asOf?: Date): Promise<IDataLakeOwnershipOfferDocument | null> {
    const doc = await this.offerModel.findOne({
      dataLakeId,
      status: 'pending',
      ...buildPendingOfferExpiryFilter(asOf),
    });
    return (doc?.toJSON() as IDataLakeOwnershipOfferDocument) ?? null;
  }

  async listPendingForRecipient(recipientUserId: string, asOf?: Date): Promise<IDataLakeOwnershipOfferDocument[]> {
    const results = await this.offerModel
      .find({ recipientUserId, status: 'pending', ...buildPendingOfferExpiryFilter(asOf) })
      .sort({ expiresAt: 1 });
    return results.map(r => r.toJSON() as IDataLakeOwnershipOfferDocument);
  }

  async expirePendingForLake(dataLakeId: string, asOf: Date): Promise<number> {
    // `expiresAt: { $lte: asOf }` mirrors `buildPendingOfferExpiryFilter`'s `$gt` boundary exactly: a
    // row is live while `expiresAt > asOf`, so at `expiresAt === asOf` it is already lapsed. Anything
    // less exact and a row could sit pending-and-hidden at the boundary forever.
    const result = await this.offerModel.updateMany(
      { dataLakeId, status: 'pending', expiresAt: { $lte: asOf } },
      { $set: { status: 'expired', resolvedAt: asOf } }
    );
    return result.modifiedCount;
  }

  async resolve(
    id: string,
    toStatus: DataLakeOwnershipOfferStatus,
    fromStatus: DataLakeOwnershipOfferStatus = 'pending'
  ): Promise<IDataLakeOwnershipOfferDocument | null> {
    // A non-ObjectId id can never address a row; answer null rather than let Mongoose raise a
    // CastError from inside the driver (BaseRepository.findById makes the same call).
    if (!mongoose.isObjectIdOrHexString(id)) return null;
    const doc = await this.offerModel.findOneAndUpdate(
      { _id: id, status: fromStatus },
      { $set: { status: toStatus, resolvedAt: new Date() } },
      { new: true }
    );
    // null means the offer was already resolved (or never existed) - the caller must treat that as
    // lost-the-race, not as success. Ownership is applied only after this returns non-null.
    return (doc?.toJSON() as IDataLakeOwnershipOfferDocument) ?? null;
  }
}

export const dataLakeOwnershipOfferRepository = new DataLakeOwnershipOfferRepository(DataLakeOwnershipOfferModel);
