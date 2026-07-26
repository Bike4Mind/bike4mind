import mongoose, { Model, Schema, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import { IModelDiscoveryState, IModelDiscoveryStateDocument, IModelDiscoveryStateRepository } from '@bike4mind/common';

/**
 * Per-model discovery bookkeeping, and the one MUTABLE collection of the three:
 * absence counters change every run and must not append a catalog row each time.
 * Only the actual transition to deprecated writes to ModelCatalog.
 */
const ModelDiscoveryStateSchema = new Schema<IModelDiscoveryStateDocument>(
  {
    modelId: { type: String, required: true, unique: true },
    lastSeenAt: { type: Date, required: false },
    firstMissAt: { type: Date, required: false },
    missCount: { type: Number, required: true, default: 0 },
    lastSourceOkAt: { type: Date, required: false },
    aggregatorKeys: {
      type: new Schema(
        {
          modelsDev: { type: String, required: false },
          litellm: { type: String, required: false },
        },
        { _id: false }
      ),
      required: false,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

export type IModelDiscoveryStateModel = Model<IModelDiscoveryStateDocument>;

export class ModelDiscoveryStateRepository
  extends BaseRepository<IModelDiscoveryStateDocument>
  implements IModelDiscoveryStateRepository
{
  constructor(model: IModelDiscoveryStateModel) {
    super(model);
  }

  async findByModelId(modelId: string): Promise<IModelDiscoveryState | null> {
    const doc = await this.model.findOne({ modelId }).lean();
    return doc as IModelDiscoveryState | null;
  }

  async recordSighting(modelId: string, at: Date = new Date()): Promise<IModelDiscoveryState> {
    const doc = await this.model.findOneAndUpdate(
      { modelId },
      { $set: { lastSeenAt: at, lastSourceOkAt: at, missCount: 0 }, $unset: { firstMissAt: '' } },
      { upsert: true, new: true }
    );
    return doc.toJSON() as IModelDiscoveryState;
  }

  async recordMiss(modelId: string, at: Date = new Date()): Promise<IModelDiscoveryState> {
    const doc = await this.model.findOneAndUpdate(
      { modelId },
      { $inc: { missCount: 1 }, $set: { lastSourceOkAt: at }, $setOnInsert: { firstMissAt: at } },
      { upsert: true, new: true }
    );
    // $setOnInsert misses the case that matters most: an existing doc whose streak
    // was cleared by a sighting. Stamp the start of the new streak here. Second
    // write only on the first miss of a streak.
    if (!doc.firstMissAt) {
      const stamped = await this.model.findOneAndUpdate({ modelId }, { $set: { firstMissAt: at } }, { new: true });
      if (stamped) return stamped.toJSON() as IModelDiscoveryState;
    }
    return doc.toJSON() as IModelDiscoveryState;
  }
}

export const ModelDiscoveryState =
  (mongoose.models['ModelDiscoveryState'] as unknown as IModelDiscoveryStateModel) ??
  model<IModelDiscoveryStateDocument>('ModelDiscoveryState', ModelDiscoveryStateSchema);
export const modelDiscoveryStateRepository = new ModelDiscoveryStateRepository(ModelDiscoveryState);
