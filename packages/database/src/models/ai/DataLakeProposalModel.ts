import mongoose, { Model, Schema } from 'mongoose';
import type {
  CreateDataLakeProposalInput,
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
// text changed materially), and the tombstone semantics depend on that history surviving.
DataLakeProposalSchema.index({ dataLakeId: 1, canonicalSourceKey: 1, createdAt: -1 });
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

  async createProposal(input: CreateDataLakeProposalInput): Promise<IDataLakeProposalDocument> {
    const doc = await this.proposalModel.create({ ...input, status: 'pending' satisfies DataLakeProposalStatus });
    return doc.toJSON() as IDataLakeProposalDocument;
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
    await this.proposalModel.updateOne(
      { _id: id },
      { $set: { status: 'pending', reviewedByUserId: null, reviewedAt: null, declineReason: null } }
    );
  }

  async deleteForLake(dataLakeId: string): Promise<number> {
    const res = await this.proposalModel.deleteMany({ dataLakeId });
    return res.deletedCount ?? 0;
  }
}

export const dataLakeProposalRepository = new DataLakeProposalRepository(DataLakeProposalModel);
