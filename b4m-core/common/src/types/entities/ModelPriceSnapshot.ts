import { z } from 'zod';
import { ModelPriceTier } from './ModelPriceTypes';

/** Object key of the snapshot in the bucket named by MODEL_PRICE_SNAPSHOT_BUCKET. Mirrored in infra/cron.ts. */
export const MODEL_PRICE_SNAPSHOT_KEY = 'model-prices/per-token.json';

/** Env var, set by infra/cron.ts where the snapshot bucket exists, holding the bucket name. */
export const MODEL_PRICE_SNAPSHOT_BUCKET_ENV = 'MODEL_PRICE_SNAPSHOT_BUCKET';

/**
 * The per-token ModelPrice rows in force, written by model discovery (VPC + Mongo) for the usage
 * poller, which has no database. Tier maps follow ModelPrice.pricing: keys are token thresholds.
 */
export const ModelPriceSnapshot = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  rows: z.array(
    z.object({
      modelId: z.string(),
      pricing: z.record(z.string().regex(/^\d+$/), ModelPriceTier),
    })
  ),
});

export type IModelPriceSnapshot = z.infer<typeof ModelPriceSnapshot>;
