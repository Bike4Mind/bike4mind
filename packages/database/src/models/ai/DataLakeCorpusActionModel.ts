import mongoose, { Model, Schema } from 'mongoose';
import type {
  IDataLakeCorpusAction,
  IDataLakeCorpusActionDocument,
  IDataLakeCorpusActionRepository,
  ListLakeCorpusActionsOptions,
} from '@bike4mind/common';
import {
  LAKE_CONFIG_CHANGE_PRINCIPAL_KINDS,
  LAKE_CORPUS_ACTION_ROLES,
  LAKE_CORPUS_ACTIONS,
  LAKE_MANAGE_RUNGS,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'DataLakeCorpusAction';

interface IDataLakeCorpusActionModel extends Model<IDataLakeCorpusActionDocument> {}

/**
 * One row per curator action that changed a lake's corpus in response to a finding (#3046). See
 * DataLakeCorpusActionTypes.ts for the field-by-field contract and for why this is a third audit
 * collection rather than more fields on LakeConfigChangeEvent.
 */
const DataLakeCorpusActionSchema = new Schema<IDataLakeCorpusActionDocument>(
  {
    lakeId: { type: String, required: true },
    findingId: { type: String, required: true },
    action: { type: String, enum: LAKE_CORPUS_ACTIONS, required: true },
    targets: {
      type: [
        new Schema(
          {
            fabFileId: { type: String, required: true },
            fileName: { type: String, default: null },
            role: { type: String, enum: LAKE_CORPUS_ACTION_ROLES, required: true },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    detail: { type: Schema.Types.Mixed, default: null },
    note: { type: String, default: null },
    actorUserId: { type: String, required: true },
    // Flattened rather than a sub-schema so the principal reads the same way here as on both
    // sibling audit models, which store the three fields at the top level too.
    principal: {
      type: new Schema(
        {
          principalKind: { type: String, enum: LAKE_CONFIG_CHANGE_PRINCIPAL_KINDS, required: true },
          principalId: { type: String, required: true },
          onBehalfOfUserId: { type: String },
        },
        { _id: false }
      ),
      required: true,
    },
    rung: { type: String, enum: LAKE_MANAGE_RUNGS, required: true },
    at: { type: Date, required: true },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// The two ways this is read: a lake's whole history, and one finding's. The `findingId` term is
// optional in `listByLake`, so a lake-only listing seeks on the prefix and still gets its sort.
DataLakeCorpusActionSchema.index({ lakeId: 1, at: -1 });
DataLakeCorpusActionSchema.index({ lakeId: 1, findingId: 1, at: -1 });

export const DataLakeCorpusActionModel: IDataLakeCorpusActionModel =
  (mongoose.models[ModelName] as IDataLakeCorpusActionModel) ||
  mongoose.model<IDataLakeCorpusActionDocument, IDataLakeCorpusActionModel>(ModelName, DataLakeCorpusActionSchema);

class DataLakeCorpusActionRepository
  extends BaseRepository<IDataLakeCorpusActionDocument>
  implements IDataLakeCorpusActionRepository
{
  constructor(private corpusActionModel: mongoose.Model<IDataLakeCorpusActionDocument>) {
    super(corpusActionModel);
  }

  async record(input: IDataLakeCorpusAction): Promise<IDataLakeCorpusActionDocument> {
    const doc = await this.corpusActionModel.create(input);
    return doc.toJSON() as IDataLakeCorpusActionDocument;
  }

  async listByLake(lakeId: string, options?: ListLakeCorpusActionsOptions): Promise<IDataLakeCorpusActionDocument[]> {
    const query = this.corpusActionModel
      .find({
        lakeId,
        ...(options?.findingId ? { findingId: options.findingId } : {}),
        ...(options?.action ? { action: options.action } : {}),
      })
      .sort({ at: -1 });
    if (options?.limit) query.limit(options.limit);
    const docs = await query;
    return docs.map(d => d.toJSON() as IDataLakeCorpusActionDocument);
  }

  async deleteForLake(lakeId: string): Promise<number> {
    const res = await this.corpusActionModel.deleteMany({ lakeId });
    return res.deletedCount ?? 0;
  }
}

export const dataLakeCorpusActionRepository = new DataLakeCorpusActionRepository(DataLakeCorpusActionModel);
