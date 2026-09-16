import mongoose from 'mongoose';
import { IResearchAgent, IResearchAgentRepository } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';
import { softDeletePlugin } from '../../utils/mongo';

const ResearchAgentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: { type: String, required: true },
    userId: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    deletedAt: { type: Date },
  },
  {
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

ResearchAgentSchema.plugin(softDeletePlugin);

const ResearchAgentModel =
  (mongoose.models['ResearchAgent'] as unknown as mongoose.Model<IResearchAgent>) ||
  mongoose.model<IResearchAgent>('ResearchAgent', ResearchAgentSchema);

class ResearchAgentRepository extends BaseRepository<IResearchAgent> implements IResearchAgentRepository {
  constructor(private researchAgentModel: mongoose.Model<IResearchAgent>) {
    super(researchAgentModel);
  }

  async findByIdAndUserId(id: string, userId: string): Promise<IResearchAgent | null> {
    // A non-ObjectId id can never address a row - report no such row, not a CastError the
    // calling route cannot attribute. Same contract as `BaseRepository.findById`.
    if (!mongoose.isObjectIdOrHexString(id)) return null;
    const result = await this.researchAgentModel.findOne({ _id: id, userId });

    return result?.toJSON() ?? null;
  }

  async findAllByUserId(userId: string): Promise<IResearchAgent[]> {
    const result = await this.researchAgentModel.find({ userId });

    return result.map(r => r.toJSON());
  }
}

export const researchAgentRepository = new ResearchAgentRepository(ResearchAgentModel);

export default ResearchAgentModel;
