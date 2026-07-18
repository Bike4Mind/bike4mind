import mongoose, { Model, Schema, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import {
  IModelPrice,
  IModelPriceDocument,
  IModelPriceInput,
  IModelPriceRepository,
  IMongoDocument,
  MODEL_PRICE_UNITS,
  ModelPriceInput,
} from '@bike4mind/common';

export type IModelPriceMongoDocument = IModelPrice & IMongoDocument;

/**
 * Versioned provider prices, one row per (model, unit, effectiveFrom).
 * Append-only: a reprice appends a new row, never edits one, so historical
 * cost beliefs stay auditable. Runtime reads rowsInForce() on the model-list
 * cache rebuild; adapter literals remain the fallback for models without rows.
 */
const ModelPriceSchema = new Schema<IModelPriceDocument>(
  {
    modelId: { type: String, required: true },
    unit: { type: String, required: true, enum: [...MODEL_PRICE_UNITS], default: 'per_token' },
    // Tier map keyed by stringified input-token threshold (Mongo map keys are strings).
    pricing: {
      type: Map,
      of: new Schema(
        {
          input: { type: Number, required: true },
          output: { type: Number, required: true },
          cache_read: { type: Number, required: false },
          cache_write: { type: Number, required: false },
          // Realtime voice audio rates; strict mode strips undeclared fields,
          // so these MUST be listed or audio pricing silently round-trips away.
          audio_input: { type: Number, required: false },
          audio_cache_read: { type: Number, required: false },
          audio_output: { type: Number, required: false },
        },
        { _id: false }
      ),
      required: true,
    },
    effectiveFrom: { type: Date, required: true },
    note: { type: String, required: false },
    repricedBy: { type: String, required: false },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Unique: concurrent seeders (parallel Lambda cold starts) collide on the
// deterministic seed epoch instead of double-inserting; reprices use a fresh
// effectiveFrom and never conflict.
ModelPriceSchema.index({ modelId: 1, unit: 1, effectiveFrom: -1 }, { unique: true });

export type IModelPriceModel = Model<IModelPriceDocument>;

export class ModelPriceRepository extends BaseRepository<IModelPriceDocument> implements IModelPriceRepository {
  constructor(model: IModelPriceModel) {
    super(model);
  }

  async append(row: IModelPriceInput): Promise<IModelPriceDocument | null> {
    // Zod first: Mongoose alone accepts empty maps and non-numeric tier keys.
    const parsed = ModelPriceInput.parse(row);
    if (Object.keys(parsed.pricing).length === 0) {
      throw new Error(`ModelPrice.append rejected ${parsed.modelId}: empty pricing map would settle calls free`);
    }
    const hasNonzeroTier = Object.values(parsed.pricing).some(tier => tier.input > 0 || tier.output > 0);
    if (!hasNonzeroTier) {
      throw new Error(
        `ModelPrice.append rejected ${parsed.modelId}: all-zero pricing would settle calls free (mark the model freeToRun instead)`
      );
    }
    return this.create(parsed as IModelPriceDocument);
  }

  async rowsInForce(at: Date = new Date()): Promise<IModelPrice[]> {
    const docs = await this.model.aggregate<IModelPriceDocument>([
      { $match: { effectiveFrom: { $lte: at } } },
      { $sort: { effectiveFrom: -1 } },
      {
        $group: {
          _id: { modelId: '$modelId', unit: '$unit' },
          doc: { $first: '$$ROOT' },
        },
      },
      { $replaceRoot: { newRoot: '$doc' } },
    ]);
    // Aggregation bypasses Mongoose casting; Map fields come back as plain objects.
    return docs.map(doc => ({ ...doc, pricing: doc.pricing }) as IModelPrice);
  }

  async historyForModel(modelId: string): Promise<IModelPrice[]> {
    const docs = await this.model.find({ modelId }).sort({ effectiveFrom: -1 }).lean();
    return docs as unknown as IModelPrice[];
  }
}

export const ModelPrice =
  (mongoose.models['ModelPrice'] as unknown as IModelPriceModel) ??
  model<IModelPriceDocument>('ModelPrice', ModelPriceSchema);
export const modelPriceRepository = new ModelPriceRepository(ModelPrice);
