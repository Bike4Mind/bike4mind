import mongoose, { Model, Schema } from 'mongoose';
import type {
  CreateDataLakeProposalInput,
  CreateDataLakeProposalResult,
  DataLakeProposalStatus,
  IDataLakeProposalDocument,
  IDataLakeProposalRepository,
  ReviewDataLakeProposalInput,
} from '@bike4mind/common';
import { DATA_LAKE_PROPOSAL_STATUSES } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'DataLakeProposal';

interface IDataLakeProposalModel extends Model<IDataLakeProposalDocument> {}

/**
 * One row per candidate a producer wants admitted to a lake (#1671). The row is the whole safety
 * mechanism: content reaches a lake only by a human moving one of these to `approved`, and the
 * approval then goes through the ordinary ingestion door. A declined row stays as the source's
 * tombstone. See DataLakeProposalTypes.ts for the field-by-field contract.
 */
const DataLakeProposalSchema = new Schema<IDataLakeProposalDocument>(
  {
    dataLakeId: { type: String, required: true },
    status: { type: String, enum: DATA_LAKE_PROPOSAL_STATUSES, required: true, default: 'pending' },
    sourceUrl: { type: String, required: true },
    canonicalSourceKey: { type: String, required: true },
    title: { type: String, required: true },
    excerpt: { type: String, default: null },
    textHash: { type: String, default: null },
    proposedTags: { type: [String], default: [] },
    confidence: { type: Number, default: null },
    provenance: {
      producer: { type: String, required: true },
      runId: { type: String },
      query: { type: String },
      retrievedAt: { type: Date, required: true },
    },
    priorDisposition: { type: String, enum: DATA_LAKE_PROPOSAL_STATUSES, default: null },
    reviewedByUserId: { type: String, default: null },
    reviewedAt: { type: Date, default: null },
    declineReason: { type: String, default: null },
    admittedFabFileId: { type: String, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Dedup read: the latest row for one source in one lake (findLatestBySourceKey). Deliberately NOT
// unique - a source legitimately gets several rows over time (declined, then re-proposed when its
// text changed materially), and the tombstone semantics depend on that history surviving. The
// uniqueness the queue does need is the narrower pending-only one below.
DataLakeProposalSchema.index({ dataLakeId: 1, canonicalSourceKey: 1, createdAt: -1 });
// At most one PENDING row per source per lake. `unique` here is a data constraint, not a query hint:
// it IS the "one open question per source" invariant the queue exists to deliver. The dedup decision
// in proposeDataLakeContent is a read followed by a write, so without this two overlapping producer
// runs for the same source both pass the "nothing pending yet" check, both insert, and a reviewer
// who approves both cards admits one source twice - the exact duplicate this queue prevents.
// Partial on `pending` so the terminal history above is untouched: a declined tombstone must not
// occupy the key and block the re-proposal its own changed-text rule is designed to allow.
// Precedent for the shape: ScopedSettingModel's live-row-only unique index.
DataLakeProposalSchema.index(
  { dataLakeId: 1, canonicalSourceKey: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } }
);
// The review queue: one lake's pending proposals, newest first.
DataLakeProposalSchema.index({ dataLakeId: 1, status: 1, createdAt: -1 });

export const DataLakeProposalModel: IDataLakeProposalModel =
  (mongoose.models[ModelName] as IDataLakeProposalModel) ||
  mongoose.model<IDataLakeProposalDocument, IDataLakeProposalModel>(ModelName, DataLakeProposalSchema);

class DataLakeProposalRepository
  extends BaseRepository<IDataLakeProposalDocument>
  implements IDataLakeProposalRepository
{
  constructor(private proposalModel: mongoose.Model<IDataLakeProposalDocument>) {
    super(proposalModel);
  }

  async createProposal(input: CreateDataLakeProposalInput): Promise<CreateDataLakeProposalResult> {
    const insert = async (): Promise<CreateDataLakeProposalResult> => {
      const doc = await this.proposalModel.create({ ...input, status: 'pending' satisfies DataLakeProposalStatus });
      return { created: true, proposal: doc.toJSON() as IDataLakeProposalDocument };
    };

    try {
      return await insert();
    } catch (error) {
      // A bare code check is unambiguous here: the pending-uniqueness index is this collection's only
      // unique index other than `_id`, whose key mongoose mints, so 11000 can mean nothing else.
      // (Contrast createDataLake, which keys on `keyPattern` because its collection carries three.)
      if ((error as { code?: number }).code !== 11000) throw error;

      const winner = await this.proposalModel.findOne({
        dataLakeId: input.dataLakeId,
        canonicalSourceKey: input.canonicalSourceKey,
        status: 'pending',
      });
      if (winner) return { created: false, pendingProposalId: winner.id };

      // No pending row despite the collision: the winner was reviewed in the instant between the
      // two, which frees the key and makes this candidate an unanswered question again. Retried
      // once only - a second collision means a third writer, and is raised rather than looped on.
      return await insert();
    }
  }

  async findLatestBySourceKey(
    dataLakeId: string,
    canonicalSourceKey: string
  ): Promise<IDataLakeProposalDocument | null> {
    const doc = await this.proposalModel.findOne({ dataLakeId, canonicalSourceKey }).sort({ createdAt: -1 });
    return (doc?.toJSON() as IDataLakeProposalDocument) ?? null;
  }

  async listByLake(
    dataLakeId: string,
    options?: { status?: DataLakeProposalStatus; limit?: number }
  ): Promise<IDataLakeProposalDocument[]> {
    const query = this.proposalModel
      .find({ dataLakeId, ...(options?.status ? { status: options.status } : {}) })
      .sort({ createdAt: -1 });
    if (options?.limit) query.limit(options.limit);
    const docs = await query;
    return docs.map(d => d.toJSON() as IDataLakeProposalDocument);
  }

  async claimForReview(id: string, input: ReviewDataLakeProposalInput): Promise<IDataLakeProposalDocument | null> {
    const { status, reviewedByUserId, reviewedAt, declineReason } = input;
    // `status: 'pending'` in the FILTER is the double-review guard: the second writer of a race
    // matches nothing and gets null. Never split into a read then a write.
    const doc = await this.proposalModel.findOneAndUpdate(
      { _id: id, status: 'pending' },
      {
        $set: {
          status,
          reviewedByUserId,
          reviewedAt,
          declineReason: declineReason ?? null,
          // A decline keeps the source identity, the reason and the reviewer, and drops the
          // candidate material itself. `textHash` survives on purpose - it is the signal that
          // detects this source coming back materially changed, and a hash is not the material.
          ...(status === 'declined' ? { excerpt: null } : {}),
        },
      },
      { new: true }
    );
    return (doc?.toJSON() as IDataLakeProposalDocument) ?? null;
  }

  async recordAdmission(id: string, fabFileId: string): Promise<void> {
    await this.proposalModel.updateOne({ _id: id }, { $set: { admittedFabFileId: fabFileId } });
  }

  async releaseClaim(id: string): Promise<void> {
    try {
      await this.proposalModel.updateOne(
        { _id: id },
        { $set: { status: 'pending', reviewedByUserId: null, reviewedAt: null, declineReason: null } }
      );
    } catch (error) {
      // The pending-uniqueness index refused the reopen, which can only mean a fresh proposal for
      // this same source (its text having changed materially) took the pending slot while the
      // approval was in flight. The open question this row would restore therefore already exists,
      // so leave it approved-but-empty - the lesser evil the approve path's own comment describes -
      // rather than let a duplicate-key throw mask the admission failure worth reporting.
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }

  async countPendingByLakes(dataLakeIds: string[]): Promise<Record<string, number>> {
    if (dataLakeIds.length === 0) return {};
    // Served by the {dataLakeId, status, createdAt} queue index - the same one listByLake uses, so
    // this adds a read path without adding an index.
    const rows = await this.proposalModel.aggregate<{ _id: string; count: number }>([
      { $match: { dataLakeId: { $in: dataLakeIds }, status: 'pending' } },
      { $group: { _id: '$dataLakeId', count: { $sum: 1 } } },
    ]);
    return Object.fromEntries(rows.map(r => [r._id, r.count]));
  }

  async deleteForLake(dataLakeId: string): Promise<number> {
    const res = await this.proposalModel.deleteMany({ dataLakeId });
    return res.deletedCount ?? 0;
  }
}

export const dataLakeProposalRepository = new DataLakeProposalRepository(DataLakeProposalModel);
