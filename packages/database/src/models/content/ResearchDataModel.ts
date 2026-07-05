import mongoose from 'mongoose';
import { softDeletePlugin } from '../../utils/mongo';
import BaseRepository from '@bike4mind/db-core';
import { IResearchData, IResearchDataRepository, IResearchDataWithFiles } from '@bike4mind/common';
import { convertPipelineForDocumentDB } from '../../utils/documentdb-compat';

const ResearchDataSchema = new mongoose.Schema(
  {
    fabFileId: { type: String, required: true },
    researchTaskId: { type: String, required: true },
    researchAgentId: { type: String, required: true },
    metaData: {
      type: {
        url: { type: String, required: false },
      },
      required: false,
      default: {},
    },
    url: { type: String },
    userId: { type: String },
    organizationId: { type: String },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
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

ResearchDataSchema.index({ 'metaData.url': 1, userId: 1 });
ResearchDataSchema.index({ 'metaData.url': 1, organizationId: 1 });

ResearchDataSchema.plugin(softDeletePlugin);

const ResearchDataModel =
  (mongoose.models['ResearchData'] as unknown as mongoose.Model<IResearchData>) ||
  mongoose.model<IResearchData>('ResearchData', ResearchDataSchema);

class ResearchDataRepository extends BaseRepository<IResearchData> implements IResearchDataRepository {
  constructor(private researchDataModel: mongoose.Model<IResearchData>) {
    super(researchDataModel);
  }

  async findAllByResearchTaskId(researchTaskId: string): Promise<IResearchData[]> {
    const result = await this.researchDataModel.find({ researchTaskId });

    return result.map(item => item.toJSON());
  }

  async findAllByResearchAgentId(researchAgentId: string): Promise<IResearchData[]> {
    const result = await this.researchDataModel.find({ researchAgentId });

    return result.map(item => item.toJSON());
  }

  async deleteAllByResearchTaskId(researchTaskId: string): Promise<void> {
    await this.researchDataModel.deleteMany({ researchTaskId });
  }

  async deleteByFabFileId(fabFileId: string): Promise<void> {
    await this.researchDataModel.deleteOne({ fabFileId });
  }

  async findByResearchAgentIdAndResearchTaskId(
    researchAgentId: string,
    researchTaskId: string
  ): Promise<IResearchData | null> {
    const result = await this.researchDataModel.findOne({ researchAgentId, researchTaskId });

    return result?.toJSON() ?? null;
  }

  async findAllByResearchTaskIdWithFiles(researchTaskId: string): Promise<IResearchDataWithFiles[]> {
    const pipeline = [
      {
        $match: {
          researchTaskId,
          $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
        },
      },
      {
        $addFields: {
          originalFabFileId: '$fabFileId',
          fabFileId: { $toObjectId: '$fabFileId' },
        },
      },
      {
        $lookup: {
          from: 'fabfiles',
          localField: 'fabFileId',
          foreignField: '_id',
          as: 'fabFile',
        },
      },
      {
        $unwind: '$fabFile',
      },
      {
        $addFields: {
          'fabFile.id': '$originalFabFileId',
          id: '$_id',
        },
      },
    ];

    const result = await this.researchDataModel.aggregate(convertPipelineForDocumentDB(pipeline));
    return result;
  }

  async findByIdAndResearchAgentId(id: string, researchAgentId: string): Promise<IResearchData | null> {
    const result = await this.researchDataModel.findOne({ _id: id, researchAgentId });
    return result?.toJSON() ?? null;
  }

  async findByMetadataUrlAndUserId(url: string, userId: string): Promise<IResearchData | null> {
    const result = await this.researchDataModel.findOne({ 'metaData.url': url, userId });
    return result?.toJSON() ?? null;
  }

  async findByMetadataUrlAndOrganizationId(url: string, organizationId: string): Promise<IResearchData | null> {
    const result = await this.researchDataModel.findOne({ 'metaData.url': url, organizationId });
    return result?.toJSON() ?? null;
  }

  async findByUrlAndUserId(url: string, userId: string): Promise<IResearchData | null> {
    const result = await this.researchDataModel.findOne({ url, userId });
    return result?.toJSON() ?? null;
  }

  async findByUrlAndOrganizationId(url: string, organizationId: string): Promise<IResearchData | null> {
    const result = await this.researchDataModel.findOne({ url, organizationId });
    return result?.toJSON() ?? null;
  }

  async existsByUrlAndResearchTaskId(url: string, researchTaskId: string): Promise<boolean> {
    const result = await this.researchDataModel.exists({ url, researchTaskId });
    return result !== null;
  }
}

export const researchDataRepository = new ResearchDataRepository(ResearchDataModel);

export default ResearchDataModel;
