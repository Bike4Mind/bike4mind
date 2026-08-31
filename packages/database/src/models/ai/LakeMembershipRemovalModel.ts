import mongoose from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import type {
  ILakeMembershipRemoval,
  ILakeMembershipRemovalDocument,
  ILakeMembershipRemovalRepository,
} from '@bike4mind/common';

// See ILakeMembershipRemoval (in @bike4mind/common) for the record's contract: a short-TTL
// restore-authorization token for #2248, not a durable "recently removed" panel.
//
// LOAD-BEARING cross-reference: `removeFileFromLake`'s `!inLake` refusal
// (dataLakeService/lakeMembership.ts) is the entire reason a row here can never be minted for a
// file this lake never held - that refusal is what makes the restore door's absent ownership test
// safe. A future door that writes a row here without that refusal reopens an unbounded add door.

const LakeMembershipRemovalSchema = new mongoose.Schema(
  {
    dataLakeId: { type: String, required: true },
    fabFileId: { type: String, required: true },
    // AUDIT ONLY - deliberately NOT read by the restore authorization, and nothing should start
    // reading it without revisiting that decision. The restore gate is the record's EXISTENCE for
    // this (lake, file): what is authorized is "this lake held this file minutes ago", not "you
    // personally removed it", so any principal the manage gate admits may restore. Scoping to the
    // actor would refuse one admin undoing another's removal, which is the narrowness #2248 exists
    // to remove. See addFileToDataLake's restore branch.
    actorUserId: { type: String, required: true },
    contentTags: [
      {
        _id: false,
        name: { type: String, required: true },
        strength: { type: Number, required: true },
      },
    ],
    removedAt: { type: Date, required: true },
    // Per-document `expiresAt` (not `createdAt` + a fixed TTL seconds) so widening the window
    // later is a data change, not an index migration - MongoDB does not re-apply a changed
    // `expireAfterSeconds` to an existing TTL index (see TelemetryAuditLogModel.ts's comment).
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// One live row per (lake, file) - the natural key, and the SAME index that serves the restore
// lookup (leading field `dataLakeId`, matching `fabFileId` too - a separate lookup index would be
// redundant). `unique: true` is not a nicety here: it is what makes the upsert in `upsertRemoval`
// atomic on this key, so two concurrent removals (a double-click, or two admins) cannot each
// insert a row and leave the later lookup to return an arbitrary one. Mirrors
// DataLakeAccessGrantModel.ts's `{ dataLakeId, principalType, principalId }` unique index.
LakeMembershipRemovalSchema.index({ dataLakeId: 1, fabFileId: 1 }, { unique: true });
// TTL sweep - storage hygiene only. The live lookup (`findLive`) filters `expiresAt` itself, since
// the sweeper's ~1-minute cycle leaves an expired row readable for a window after it expires.
LakeMembershipRemovalSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const LakeMembershipRemovalModel =
  (mongoose.models['LakeMembershipRemoval'] as unknown as mongoose.Model<ILakeMembershipRemovalDocument>) ||
  mongoose.model<ILakeMembershipRemovalDocument>('LakeMembershipRemoval', LakeMembershipRemovalSchema);

class LakeMembershipRemovalRepository
  extends BaseRepository<ILakeMembershipRemovalDocument>
  implements ILakeMembershipRemovalRepository
{
  constructor(private removalModel: mongoose.Model<ILakeMembershipRemovalDocument>) {
    super(removalModel);
  }

  async upsertRemoval(input: ILakeMembershipRemoval): Promise<ILakeMembershipRemovalDocument> {
    const { dataLakeId, fabFileId, actorUserId, contentTags, removedAt, expiresAt } = input;
    const doc = await this.removalModel.findOneAndUpdate(
      { dataLakeId, fabFileId },
      { $set: { actorUserId, contentTags, removedAt, expiresAt } },
      { new: true, upsert: true }
    );
    return doc.toJSON() as ILakeMembershipRemovalDocument;
  }

  async findLive(
    dataLakeId: string,
    fabFileId: string,
    asOf: Date = new Date()
  ): Promise<ILakeMembershipRemovalDocument | null> {
    const doc = await this.removalModel.findOne({ dataLakeId, fabFileId, expiresAt: { $gt: asOf } });
    return (doc?.toJSON() as ILakeMembershipRemovalDocument) ?? null;
  }
}

export const lakeMembershipRemovalRepository = new LakeMembershipRemovalRepository(LakeMembershipRemovalModel);
