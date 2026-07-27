import mongoose, { Model, Schema, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import {
  IModelDiscoveryState,
  IModelDiscoveryStateDocument,
  IModelDiscoveryStateRepository,
  IModelLifecycleSuggestion,
  ModelLifecycleSuggestionInput,
} from '@bike4mind/common';

/** The content half of a suggestion: what two suggestions are compared on. */
const SUGGESTION_CONTENT_FIELDS = ['status', 'deprecationDate', 'retirementDate', 'replacedBy'] as const;

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
    suggestion: {
      type: new Schema(
        {
          status: { type: String, required: false },
          deprecationDate: { type: String, required: false },
          retirementDate: { type: String, required: false },
          replacedBy: { type: String, required: false },
          source: { type: String, required: true },
          suggestedAt: { type: Date, required: true },
          resolvedAt: { type: Date, required: false },
          resolution: { type: String, required: false, enum: ['accepted', 'dismissed'] },
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

// The deprecation queue's only query. Sparse so the rows with no suggestion -
// every model on a healthy deployment - stay out of the index.
ModelDiscoveryStateSchema.index({ 'suggestion.resolution': 1 }, { sparse: true });

export type IModelDiscoveryStateModel = Model<IModelDiscoveryStateDocument>;

/** True when two suggestions say the same thing, resolution bookkeeping aside. */
function sameSuggestionContent(
  held: Pick<IModelLifecycleSuggestion, (typeof SUGGESTION_CONTENT_FIELDS)[number]>,
  next: ModelLifecycleSuggestionInput
): boolean {
  return SUGGESTION_CONTENT_FIELDS.every(field => (held[field] ?? null) === (next[field] ?? null));
}

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

  async findByModelIds(modelIds: readonly string[]): Promise<IModelDiscoveryState[]> {
    if (modelIds.length === 0) return [];
    const docs = await this.model.find({ modelId: { $in: [...modelIds] } }).lean();
    return docs as IModelDiscoveryState[];
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

  async recordSuggestion(
    modelId: string,
    suggestion: ModelLifecycleSuggestionInput,
    at: Date = new Date()
  ): Promise<IModelDiscoveryState> {
    const existing = (await this.model.findOne({ modelId }).lean()) as IModelDiscoveryState | null;
    const held = existing?.suggestion;
    const unchanged = held !== undefined && sameSuggestionContent(held, suggestion);
    // Re-raising what an operator already settled would put a dismissed model
    // back in the queue every run. Different content is a NEW proposal and does
    // go back, unresolved.
    if (held?.resolution && unchanged) return existing as IModelDiscoveryState;

    // Every run re-raises the same unresolved item, so re-stamping it would make
    // the queue's age read as today forever and hide how long it has waited.
    const suggestedAt = unchanged ? held.suggestedAt : at;
    const doc = await this.model.findOneAndUpdate(
      { modelId },
      { $set: { suggestion: { ...suggestion, suggestedAt } } },
      { upsert: true, new: true }
    );
    return doc.toJSON() as IModelDiscoveryState;
  }

  async pendingSuggestions(): Promise<IModelDiscoveryState[]> {
    const docs = await this.model
      .find({ suggestion: { $exists: true }, 'suggestion.resolution': { $exists: false } })
      .lean();
    return docs as IModelDiscoveryState[];
  }

  async resolveSuggestion(
    modelId: string,
    resolution: NonNullable<IModelLifecycleSuggestion['resolution']>,
    at: Date = new Date()
  ): Promise<IModelDiscoveryState | null> {
    const doc = await this.model.findOneAndUpdate(
      { modelId, suggestion: { $exists: true } },
      { $set: { 'suggestion.resolvedAt': at, 'suggestion.resolution': resolution } },
      { new: true }
    );
    return doc ? (doc.toJSON() as IModelDiscoveryState) : null;
  }
}

export const ModelDiscoveryState =
  (mongoose.models['ModelDiscoveryState'] as unknown as IModelDiscoveryStateModel) ??
  model<IModelDiscoveryStateDocument>('ModelDiscoveryState', ModelDiscoveryStateSchema);
export const modelDiscoveryStateRepository = new ModelDiscoveryStateRepository(ModelDiscoveryState);
