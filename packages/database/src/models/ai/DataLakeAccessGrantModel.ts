import mongoose from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import type {
  IDataLakeAccessGrant,
  IDataLakeAccessGrantDocument,
  IDataLakeAccessGrantRepository,
  DataLakePrincipalType,
} from '@bike4mind/common';
import { DATA_LAKE_ACCESS_ROLES, DATA_LAKE_PRINCIPAL_TYPES } from '@bike4mind/common';

// See IDataLakeAccessGrant (in @bike4mind/common) for the relation's contract and the naming
// rationale (AccessGrant = user/org-to-lake access, NOT the file-in-lake `DataLakeMembership*`).

const DataLakeAccessGrantSchema = new mongoose.Schema(
  {
    dataLakeId: { type: String, required: true },
    // `enum` wants a mutable string[]; the source arrays are `as const` tuples (so Zod can build a
    // literal union from them), hence the spread. One source of truth - the Mongoose enum and the
    // Zod enum both key off the same exported array, so a new role/principal kind can't be added to
    // one layer and forgotten in the other.
    principalType: { type: String, enum: [...DATA_LAKE_PRINCIPAL_TYPES], required: true },
    principalId: { type: String, required: true },
    role: { type: String, enum: [...DATA_LAKE_ACCESS_ROLES], required: true },
    grantedByUserId: { type: String, required: true },
    // Optional expiry. Deliberately NO Mongo TTL index: an expired grant is filtered at read time
    // (see buildActiveGrantFilter) but kept in the collection so the audit trail (#1663) and the
    // owner-facing membership view (#1672) can still show a lapsed grant. A TTL index would delete
    // the very record those surfaces exist to display.
    expiresAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// One live grant per principal per lake - the natural key. `dataLakeId` is the leading field, so
// listByLake (equality on dataLakeId) is served by this same index; a separate { dataLakeId }
// index would be redundant.
DataLakeAccessGrantSchema.index({ dataLakeId: 1, principalType: 1, principalId: 1 }, { unique: true });
// Read-time resolution: "which lakes can this principal reach" (#1673) - equality on
// (principalType, principalId).
DataLakeAccessGrantSchema.index({ principalType: 1, principalId: 1 });

export const DataLakeAccessGrantModel =
  (mongoose.models['DataLakeAccessGrant'] as unknown as mongoose.Model<IDataLakeAccessGrantDocument>) ||
  mongoose.model<IDataLakeAccessGrantDocument>('DataLakeAccessGrant', DataLakeAccessGrantSchema);

/**
 * The "still live at `asOf`" filter fragment, shared by every read path so the expiry rule cannot
 * drift between them. A grant is active when it has no expiry (null OR the field absent) OR its
 * expiry is strictly after `asOf`. Returns an empty fragment when `asOf` is omitted - callers that
 * want the full set including lapsed grants (audit / membership view) pass nothing. Per-arm null/''
 * form (not `$in: [null]`) for DocumentDB safety, matching the DataLake model's other filters.
 */
export const buildActiveGrantFilter = (asOf?: Date): Record<string, unknown> =>
  asOf ? { $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gt: asOf } }] } : {};

class DataLakeAccessGrantRepository
  extends BaseRepository<IDataLakeAccessGrantDocument>
  implements IDataLakeAccessGrantRepository
{
  constructor(private grantModel: mongoose.Model<IDataLakeAccessGrantDocument>) {
    super(grantModel);
  }

  async listByLake(dataLakeId: string, opts?: { activeAsOf?: Date }): Promise<IDataLakeAccessGrantDocument[]> {
    const results = await this.grantModel.find({ dataLakeId, ...buildActiveGrantFilter(opts?.activeAsOf) });
    return results.map(r => r.toJSON() as IDataLakeAccessGrantDocument);
  }

  async listByPrincipal(
    principalType: DataLakePrincipalType,
    principalId: string,
    opts?: { activeAsOf?: Date }
  ): Promise<IDataLakeAccessGrantDocument[]> {
    const results = await this.grantModel.find({
      principalType,
      principalId,
      ...buildActiveGrantFilter(opts?.activeAsOf),
    });
    return results.map(r => r.toJSON() as IDataLakeAccessGrantDocument);
  }

  async findGrant(
    dataLakeId: string,
    principalType: DataLakePrincipalType,
    principalId: string
  ): Promise<IDataLakeAccessGrantDocument | null> {
    const doc = await this.grantModel.findOne({ dataLakeId, principalType, principalId });
    return (doc?.toJSON() as IDataLakeAccessGrantDocument) ?? null;
  }

  async upsertGrant(input: IDataLakeAccessGrant): Promise<IDataLakeAccessGrantDocument> {
    const { dataLakeId, principalType, principalId, role, grantedByUserId, expiresAt } = input;
    const set: Record<string, unknown> = { role, grantedByUserId };
    // expiresAt: undefined -> leave any existing expiry untouched (a role change shouldn't silently
    // clear a trial's expiry); null -> clear it; a Date -> set it. The filter fields land on insert
    // via Mongo's upsert-from-query, so they need no $setOnInsert.
    if (expiresAt !== undefined) set.expiresAt = expiresAt;
    const doc = await this.grantModel.findOneAndUpdate(
      { dataLakeId, principalType, principalId },
      { $set: set },
      { new: true, upsert: true }
    );
    return doc.toJSON() as IDataLakeAccessGrantDocument;
  }

  async removeGrant(dataLakeId: string, principalType: DataLakePrincipalType, principalId: string): Promise<boolean> {
    const res = await this.grantModel.deleteOne({ dataLakeId, principalType, principalId });
    return res.deletedCount === 1;
  }

  async removeAllForLake(dataLakeId: string): Promise<number> {
    const res = await this.grantModel.deleteMany({ dataLakeId });
    return res.deletedCount ?? 0;
  }
}

export const dataLakeAccessGrantRepository = new DataLakeAccessGrantRepository(DataLakeAccessGrantModel);
