import mongoose, { Model, Schema } from 'mongoose';
import type {
  CreateDataLakeResearchConfigInput,
  IDataLakeResearchConfigDocument,
  IDataLakeResearchConfigRepository,
  UpdateDataLakeResearchConfigInput,
} from '@bike4mind/common';
import { RESEARCH_RUN_TRIGGERS } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'DataLakeResearchConfig';

interface IDataLakeResearchConfigModel extends Model<IDataLakeResearchConfigDocument> {}

/**
 * One saved, reusable research-run configuration for one lake (#1682). See
 * DataLakeResearchTypes.ts for what each lever means and why the bounds are where they are.
 *
 * Every lever is `required` with a schema-level default rather than optional: a config written by
 * an older client and then RUN would otherwise reach the loop with `undefined` where a number is
 * expected, and the loop's own clamps would read that as "no limit" on exactly the fields that
 * bound spend.
 */
const DataLakeResearchConfigSchema = new Schema<IDataLakeResearchConfigDocument>(
  {
    dataLakeId: { type: String, required: true },
    name: { type: String, required: true },
    query: { type: String, required: true },
    // No default: absent means "the service's current default model", which is deliberately
    // resolved at run time so a retired model does not strand a saved config.
    model: { type: String },
    maxResults: { type: Number, required: true },
    maxProposals: { type: Number, required: true },
    recencyDays: { type: Number, default: null },
    allowedDomains: { type: [String], default: [] },
    blockedDomains: { type: [String], default: [] },
    minRelevance: { type: Number, required: true },
    costCeilingMicroUsd: { type: Number, required: true },
    proposedTags: { type: [String], default: [] },
    trigger: { type: String, enum: RESEARCH_RUN_TRIGGERS, required: true },
    createdByUserId: { type: String, required: true },
    lastUpdatedByUserId: { type: String, default: null },
    lastRunAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// The only read path: one lake's configs, newest first.
DataLakeResearchConfigSchema.index({ dataLakeId: 1, createdAt: -1 });

export const DataLakeResearchConfigModel: IDataLakeResearchConfigModel =
  (mongoose.models[ModelName] as IDataLakeResearchConfigModel) ||
  mongoose.model<IDataLakeResearchConfigDocument, IDataLakeResearchConfigModel>(
    ModelName,
    DataLakeResearchConfigSchema
  );

class DataLakeResearchConfigRepository
  extends BaseRepository<IDataLakeResearchConfigDocument>
  implements IDataLakeResearchConfigRepository
{
  constructor(private configModel: mongoose.Model<IDataLakeResearchConfigDocument>) {
    super(configModel);
  }

  async createConfig(input: CreateDataLakeResearchConfigInput): Promise<IDataLakeResearchConfigDocument> {
    const doc = await this.configModel.create(input);
    return doc.toJSON() as IDataLakeResearchConfigDocument;
  }

  async listByLake(dataLakeId: string): Promise<IDataLakeResearchConfigDocument[]> {
    const docs = await this.configModel.find({ dataLakeId }).sort({ createdAt: -1 });
    return docs.map(d => d.toJSON() as IDataLakeResearchConfigDocument);
  }

  async findByIdInLake(id: string, dataLakeId: string): Promise<IDataLakeResearchConfigDocument | null> {
    // `.catch(() => null)` rather than a pre-validation of `id`: findOne REJECTS on a non-ObjectId
    // string, so a caller passing a junk id would get a 500 where the honest answer is "no such
    // config". Same shape as assertLakeAccess's by-id lookup.
    const doc = await this.configModel.findOne({ _id: id, dataLakeId }).catch(() => null);
    return (doc?.toJSON() as IDataLakeResearchConfigDocument) ?? null;
  }

  async updateConfig(
    id: string,
    dataLakeId: string,
    input: UpdateDataLakeResearchConfigInput
  ): Promise<IDataLakeResearchConfigDocument | null> {
    // `dataLakeId` in the FILTER, not just the caller's gate: it is what makes a config
    // unreachable from another lake's route even if the id leaks.
    const doc = await this.configModel
      .findOneAndUpdate({ _id: id, dataLakeId }, { $set: input }, { new: true })
      .catch(() => null);
    return (doc?.toJSON() as IDataLakeResearchConfigDocument) ?? null;
  }

  async recordRunStarted(id: string, at: Date): Promise<void> {
    await this.configModel.updateOne({ _id: id }, { $set: { lastRunAt: at } }).catch(() => undefined);
  }

  async deleteConfig(id: string, dataLakeId: string): Promise<boolean> {
    const res = await this.configModel.deleteOne({ _id: id, dataLakeId }).catch(() => null);
    return (res?.deletedCount ?? 0) > 0;
  }

  async deleteForLake(dataLakeId: string): Promise<number> {
    const res = await this.configModel.deleteMany({ dataLakeId });
    return res.deletedCount ?? 0;
  }
}

export const dataLakeResearchConfigRepository = new DataLakeResearchConfigRepository(DataLakeResearchConfigModel);
