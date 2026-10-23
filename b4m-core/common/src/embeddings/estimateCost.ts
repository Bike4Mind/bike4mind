import type { SupportedEmbeddingModel } from '../schemas/embedding';
import { EMBEDDING_MODEL_CATALOG } from './catalog';

const usdPerTokenOf = (model: string): number | undefined => {
  const pricing = EMBEDDING_MODEL_CATALOG[model as SupportedEmbeddingModel]?.pricing;
  return pricing ? pricing.usdPerMillionTokens / 1_000_000 : undefined;
};

/**
 * Does the catalog hold a rate for this model, as opposed to settling $0 because it has none?
 *
 * `getEmbeddingModelCost` cannot tell those apart from the outside: a locally-hosted embedder priced
 * at an explicit 0 and a model with no rate at all both return 0. A usage-event write does not care -
 * a SPEND PREFLIGHT does, because quoting $0 as truth is the one lie a spend gate must not tell.
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
