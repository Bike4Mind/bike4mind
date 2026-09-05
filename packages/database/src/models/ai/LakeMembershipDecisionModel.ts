import mongoose from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import type {
  ILakeMembershipDecision,
  ILakeMembershipDecisionDocument,
  ILakeMembershipDecisionRepository,
} from '@bike4mind/common';
import { LAKE_MEMBERSHIP_DECISION_SOURCES, LAKE_MEMBERSHIP_DECISION_VALUES } from '@bike4mind/common';

// See ILakeMembershipDecision (in @bike4mind/common) for the record's contract: the durable tombstone
// that stops a membership repair re-asking a question its owner already answered (#2245).
//
// Deliberately NOT a TTL collection, unlike its LakeMembershipRemoval neighbour. Staleness here is
// semantic, not temporal: a row stops applying when `groupIdentity` no longer matches the group it
// was made about, which the PLANNER decides. Nothing in this collection expires on a clock.

const LakeMembershipDecisionSchema = new mongoose.Schema(
  {
    dataLakeId: { type: String, required: true },
    fileName: { type: String, required: true },
    // Enums sourced from the planner's own constants, so a value that round-trips through Mongo is
    // by construction a value `planMembershipRepair`/`membersRemovedByDecision` can act on. A string
    // literal here would let the two drift and fail at the far end, on live data.
    decision: { type: String, enum: LAKE_MEMBERSHIP_DECISION_VALUES, required: true },
    keptFabFileId: { type: String, default: null },
    groupIdentity: { type: String, required: true },
    decidedByUserId: { type: String, required: true },
    decidedAt: { type: Date, required: true },
    source: { type: String, enum: LAKE_MEMBERSHIP_DECISION_SOURCES, required: true },
  },
  // `virtuals` is what puts `id` on the object `toJSON()` returns, and this repository returns
  // exactly that, typed as ILakeMembershipDecisionDocument - which declares `id: string`. Without it
  // every row comes back with only `_id` and the declared field is undefined at runtime, so
  // `BaseRepository.update` rejects a row this repository itself just handed out. Matches the other
  // data-lake schemas.
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

// One ruling per (lake, name) - the natural key, and the same index that serves `listByLake` on its
// leading field. `unique` is a data constraint rather than a hint: it is what makes `upsertDecision`
// atomic on the key, so an owner double-submitting a decision, or the admission door (#2238) writing
// one while a repair run writes another, cannot leave two contradictory rulings for one name with
// the plan free to pick either.
LakeMembershipDecisionSchema.index({ dataLakeId: 1, fileName: 1 }, { unique: true });

// The keptFabFileId/decision pairing is a DATA constraint, enforced here rather than only in
// `recordMembershipDecision`. That service is one writer of several: `BaseRepository` gives this
// repository `create`, `update` and `updateMany` for free, and the type file already declares a
// second door (`source: 'admission'`) with no reason to route through the service. A `keep-specific`
// naming nobody reads to every surface as a ruling the owner made while removing nothing, forever.
//
// Two hooks rather than a conditional `required`: mongoose binds `this` in an update validator to
// the QUERY, not the document, so a `required` function cannot see a sibling path on the
// findOneAndUpdate path - which is the path every write in this repository actually takes.
const assertKeptPairing = (decision: unknown, keptFabFileId: unknown) => {
  if (decision === 'keep-specific' && !keptFabFileId) {
    throw new Error('keptFabFileId is required for a keep-specific decision');
  }
  if (decision !== undefined && decision !== 'keep-specific' && keptFabFileId) {
    throw new Error(`keptFabFileId is only meaningful for keep-specific, not ${String(decision)}`);
  }
};

LakeMembershipDecisionSchema.pre('validate', function () {
  assertKeptPairing(this.decision, this.keptFabFileId);
});

// `updateOne`/`updateMany` are included even though nothing calls them on this collection today:
// leaving a door unguarded because it is currently unused is how the service-only check became
// bypassable in the first place.
LakeMembershipDecisionSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function () {
  const update = (this.getUpdate() ?? {}) as Record<string, unknown> & { $set?: Record<string, unknown> };
  // A write can name the fields at the top level or under $set; a partial update that names neither
  // leaves both undefined and the guard passes, which is correct - it changed neither.
  const fields = { ...update, ...(update.$set ?? {}) };
  assertKeptPairing(fields.decision, fields.keptFabFileId);
});

export const LakeMembershipDecisionModel =
  (mongoose.models['LakeMembershipDecision'] as unknown as mongoose.Model<ILakeMembershipDecisionDocument>) ||
  mongoose.model<ILakeMembershipDecisionDocument>('LakeMembershipDecision', LakeMembershipDecisionSchema);

class LakeMembershipDecisionRepository
  extends BaseRepository<ILakeMembershipDecisionDocument>
  implements ILakeMembershipDecisionRepository
{
  constructor(private decisionModel: mongoose.Model<ILakeMembershipDecisionDocument>) {
    super(decisionModel);
  }

  async upsertDecision(input: ILakeMembershipDecision): Promise<ILakeMembershipDecisionDocument> {
    const { dataLakeId, fileName, decision, keptFabFileId, groupIdentity, decidedByUserId, decidedAt, source } = input;
    const doc = await this.decisionModel.findOneAndUpdate(
      { dataLakeId, fileName },
      // `keptFabFileId` is written unconditionally, null included: a keep-specific ruling later
      // changed to keep-newest must not leave the old kept id behind, where `membersRemovedByDecision`
      // would ignore it today and some future reader would treat it as the owner's choice.
      { $set: { decision, keptFabFileId: keptFabFileId ?? null, groupIdentity, decidedByUserId, decidedAt, source } },
      // `runValidators` is NOT the default on findOneAndUpdate, and without it the `decision` and
      // `source` enums above are decorative on this path - the only path that writes a row. A value
      // the planner cannot act on would persist silently and fail later, at a read, on live data.
      { new: true, upsert: true, runValidators: true }
    );
    return doc.toJSON() as ILakeMembershipDecisionDocument;
  }

  async listByLake(dataLakeId: string): Promise<ILakeMembershipDecisionDocument[]> {
    const docs = await this.decisionModel.find({ dataLakeId }).sort({ fileName: 1 });
    return docs.map(d => d.toJSON() as ILakeMembershipDecisionDocument);
  }

  async clearDecision(dataLakeId: string, fileName: string): Promise<boolean> {
    const { deletedCount } = await this.decisionModel.deleteOne({ dataLakeId, fileName });
    return (deletedCount ?? 0) > 0;
  }

  async deleteForLake(dataLakeId: string): Promise<number> {
    const { deletedCount } = await this.decisionModel.deleteMany({ dataLakeId });
    return deletedCount ?? 0;
  }
}

export const lakeMembershipDecisionRepository = new LakeMembershipDecisionRepository(LakeMembershipDecisionModel);
