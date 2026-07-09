import { z } from 'zod';
import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

/**
 * Billing unit for a price row. per_token rows overlay ModelInfo.pricing (the
 * getTextModelCost path); other units are read by their own settlement paths
 * (per_minute: realtime voice, per_image: image generation).
 */
export const MODEL_PRICE_UNITS = ['per_token', 'per_minute', 'per_image'] as const;

export type ModelPriceUnit = (typeof MODEL_PRICE_UNITS)[number];

/** One pricing tier, same shape as ModelInfo.pricing values. */
export const ModelPriceTier = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cache_read: z.number().nonnegative().optional(),
  cache_write: z.number().nonnegative().optional(),
});

/**
 * One versioned provider price for one model. Rows are append-only: a
 * reprice is a NEW row with a later effectiveFrom, never an edit, so
 * "what did we believe this model cost at time T" stays answerable
 * (invoice reconciliation) and every change carries provenance.
 */
export const ModelPrice = z.object({
  id: z.string().optional(),
  /** Exact ModelInfo.id the row prices. */
  modelId: z.string(),
  unit: z.enum(MODEL_PRICE_UNITS).default('per_token'),
  /**
   * Tier map mirroring ModelInfo.pricing: keys are input-token thresholds
   * (stringified numbers - JSON/Mongo map keys), values in USD per token
   * (per minute/image for non-token units, using `input` as the unit rate).
   * Keys must be digits: Number('anything else') is NaN, which scrambles
   * getTextModelCost tier selection.
   */
  pricing: z.record(z.string().regex(/^\d+$/, 'tier keys must be numeric token thresholds'), ModelPriceTier),
  /** The row prices calls made at or after this instant, until a newer row starts. */
  effectiveFrom: z.date(),
  /** Provenance: 'adapter-seed', an invoice reference, a price-page URL, etc. */
  note: z.string().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type IModelPrice = z.infer<typeof ModelPrice>;

export type IModelPriceDocument = IModelPrice & IMongoDocument;

/** Zod schema for appending a row (server sets id/timestamps). Repositories
 * must parse against this before persisting: Mongoose alone accepts empty
 * maps and non-numeric tier keys, both of which corrupt billing. */
export const ModelPriceInput = ModelPrice.omit({ id: true, createdAt: true, updatedAt: true });

export type IModelPriceInput = z.infer<typeof ModelPriceInput>;

export interface IModelPriceRepository extends IBaseRepository<IModelPriceDocument> {
  /** Append one price row (append-only: never edits an existing row). */
  append(row: IModelPriceInput): Promise<IModelPriceDocument | null>;

  /** All rows in force at the given time (default now): newest effectiveFrom <= at, one per model+unit. */
  rowsInForce(at?: Date): Promise<IModelPrice[]>;

  /** Full history for one model, newest first (audit / invoice disputes). */
  historyForModel(modelId: string): Promise<IModelPrice[]>;
}
