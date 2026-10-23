import type { SupportedEmbeddingModel } from '../schemas/embedding';
import { EMBEDDING_MODEL_CATALOG } from './catalog';

const usdPerTokenOf = (model: string): number | undefined => {
  // hasOwn: an id like 'constructor' must not resolve to an Object.prototype member.
  if (!Object.hasOwn(EMBEDDING_MODEL_CATALOG, model)) return undefined;
  const { pricing } = EMBEDDING_MODEL_CATALOG[model as SupportedEmbeddingModel];
  return pricing ? pricing.usdPerMillionTokens / 1_000_000 : undefined;
};

/**
 * Does the catalog hold a rate for this model? `getEmbeddingModelCost` returns 0 both for an explicit $0 rate and
 * for no rate at all; spend preflights must refuse the latter.
 */
export const hasPublishedEmbeddingRate = (model: string): boolean => usdPerTokenOf(model) !== undefined;

/** Compute USD cost for an embedding call (input tokens only). Unpriced models settle $0 with an alarm. */
export const getEmbeddingModelCost = (model: string, inputTokens: number): number => {
  const rate = usdPerTokenOf(model);
  if (rate === undefined) {
    if (inputTokens > 0) {
      console.error(`[UNPRICED_EMBEDDING_MODEL] ${model} computed $0 for ${inputTokens} tokens; add its rate`);
    }
    return 0;
  }
  return rate * inputTokens;
};
