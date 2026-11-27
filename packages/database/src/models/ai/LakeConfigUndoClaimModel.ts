import mongoose from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import type { ILakeConfigUndoClaimDocument, ILakeConfigUndoClaimRepository } from '@bike4mind/common';

// One row per undone History event (see LakeConfigUndoClaimTypes.ts). No TTL: the row is the only
// record that an event was undone, and it must outlive the History row that says so.

const LakeConfigUndoClaimSchema = new mongoose.Schema(
  {
    dataLakeId: { type: String, required: true },
    eventId: { type: String, required: true },
    undoEventId: { type: String },
  },
  { timestamps: true }
);

// The one-undo-per-event guard, across config and membership events alike.
LakeConfigUndoClaimSchema.index({ dataLakeId: 1, eventId: 1 }, { unique: true });

export const LakeConfigUndoClaimModel: mongoose.Model<ILakeConfigUndoClaimDocument> =
  (mongoose.models['LakeConfigUndoClaim'] as unknown as mongoose.Model<ILakeConfigUndoClaimDocument>) ||
  mongoose.model<ILakeConfigUndoClaimDocument>('LakeConfigUndoClaim', LakeConfigUndoClaimSchema);

class LakeConfigUndoClaimRepository
  extends BaseRepository<ILakeConfigUndoClaimDocument>
  implements ILakeConfigUndoClaimRepository
{
  constructor(private claimModel: mongoose.Model<ILakeConfigUndoClaimDocument>) {
    super(claimModel);
  }

  async claim(dataLakeId: string, eventId: string, undoEventId?: string): Promise<boolean> {
    try {
      await this.claimModel.create({ dataLakeId, eventId, undoEventId });
      return true;
    } catch (error) {
      // The unique index is this collection's only one besides `_id`, so 11000 can mean nothing else.
      if ((error as { code?: number }).code === 11000) return false;
      throw error;
    }
  }

  async release(dataLakeId: string, eventId: string): Promise<void> {
    await this.claimModel.deleteOne({ dataLakeId, eventId });
  }

  async listForEvents(dataLakeId: string, eventIds: string[]): Promise<ILakeConfigUndoClaimDocument[]> {
    if (eventIds.length === 0) return [];
    const docs = await this.claimModel.find({ dataLakeId, eventId: { $in: eventIds } });
    return docs.map(d => d.toJSON() as ILakeConfigUndoClaimDocument);
  }

  async deleteForLake(dataLakeId: string): Promise<number> {
    const { deletedCount } = await this.claimModel.deleteMany({ dataLakeId });
    return deletedCount ?? 0;
  }
}

export const lakeConfigUndoClaimRepository = new LakeConfigUndoClaimRepository(LakeConfigUndoClaimModel);
