import mongoose from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import type {
  ILakeMembershipDecision,
  ILakeMembershipDecisionDocument,
  ILakeMembershipDecisionRepository,
} from '@bike4mind/common';
import { BadRequestError, LAKE_MEMBERSHIP_DECISION_SOURCES, LAKE_MEMBERSHIP_DECISION_VALUES } from '@bike4mind/common';

// See ILakeMembershipDecision (in @bike4mind/common) for the record's contract: the durable tombstone
// that stops a membership repair re-asking a question its owner already answered.
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
// atomic on the key, so an owner double-submitting a decision, or the admission door writing
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
    throw new BadRequestError('keptFabFileId is required for a keep-specific decision');
  }
  if (decision !== undefined && decision !== 'keep-specific' && keptFabFileId) {
    throw new BadRequestError(`keptFabFileId is only meaningful for keep-specific, not ${String(decision)}`);
  }
};

LakeMembershipDecisionSchema.pre('validate', function () {
  assertKeptPairing(this.decision, this.keptFabFileId);
});

// Every write verb that reaches Mongo through a Query is listed, including the four nothing calls
// today: leaving a door unguarded because it is currently unused is how the service-only check
// became bypassable in the first place. The replace verbs are NOT inert here - mongoose applies
// schema defaults AFTER this hook, so a replacement that omits keptFabFileId reads as one half and
// is refused even though `default: null` would have landed. Name both halves on a replace.
//
// What this still cannot close: `bulkWrite`, which goes straight to the driver collection without
// building a Query, so only a model-level `pre('bulkWrite')` would see it. Everything else that
// evades the payload read below is refused outright rather than waved through - see the guards.
LakeMembershipDecisionSchema.pre(
  ['findOneAndUpdate', 'findOneAndReplace', 'updateOne', 'updateMany', 'replaceOne'],
  function () {
    const raw = this.getUpdate() ?? {};
    // A pipeline update is an array of stages, and its writes are computed by the server - there is
    // no payload here to read a pairing out of. Refused rather than skipped, which is what the
    // early return below would otherwise do.
    if (Array.isArray(raw)) {
      throw new BadRequestError('pipeline updates are not supported on this collection');
    }
    const update = raw as Record<string, unknown> & {
      $set?: Record<string, unknown>;
      $setOnInsert?: Record<string, unknown>;
      $unset?: Record<string, unknown>;
    };

    // Two operators whose effect on the pairing this hook cannot determine, so neither is allowed
    // to touch it. `$setOnInsert` applies only when the upsert inserts, so the pair it produces is a
    // property of whether the row already existed, not of the write - the one thing this guard
    // insists a pairing must be. `$unset` removes a half, which is a pairing change no value test
    // can see. Both have an unambiguous spelling: name both halves in `$set`.
    const namesEitherHalf = (o?: Record<string, unknown>) =>
      o !== undefined && ('decision' in o || 'keptFabFileId' in o);
    if (namesEitherHalf(update.$setOnInsert)) {
      throw new BadRequestError('name decision and keptFabFileId in $set, not $setOnInsert');
    }
    if (namesEitherHalf(update.$unset)) {
      throw new BadRequestError('decision and keptFabFileId cannot be unset; write both explicitly');
    }

    // A write can name the fields at the top level or under $set.
    const fields = { ...update, ...(update.$set ?? {}) };
    // Presence of a VALUE, not of a key. `{ decision: undefined }` is ordinary well-typed TypeScript
    // - `update` takes a Partial - and mongoose deletes undefined keys while casting, which happens
    // AFTER this hook runs. So `'decision' in fields` would see a half that Mongo never receives and
    // wave through the exact single-half write below refuses. `null` stays distinguishable, which is
    // what `keptFabFileId: null` on a non-keep-specific ruling depends on.
    const namesDecision = fields.decision !== undefined;
    const namesKept = fields.keptFabFileId !== undefined;

    // BOTH HALVES OR NEITHER, rather than validating whichever half the write happened to name. An
    // update sees only its own payload, never the stored row, so a write naming one half is checked
    // against an unknown other half and passes by default - `{ keptFabFileId: 'f1' }` onto a stored
    // `keep-newest`, or `{ decision: 'keep-newest' }` onto a row already holding a kept id, each
    // produce exactly the pairing below refuses to create. Requiring both makes the resulting pair a
    // property of the write, which is the most an update hook can actually know.
    if (namesDecision !== namesKept) {
      // Same class as the service's own rejection of this pairing, so both doors answer 400.
      throw new BadRequestError('decision and keptFabFileId must be written together, or neither');
    }
    // Neither named: a partial update touching other fields, which changes no pairing. Correct to pass.
    if (!namesDecision) return;
    assertKeptPairing(fields.decision, fields.keptFabFileId);
  }
);

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
