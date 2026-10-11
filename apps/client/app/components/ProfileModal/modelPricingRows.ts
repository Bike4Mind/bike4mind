import { getTextModelCreditsPer1M, normalizeModelsDevKey, type ModelInfo } from '@bike4mind/common';

/**
 * One key per model per backend. A dated snapshot and its alias (`gpt-4.1-2025-04-14` and a
 * discovered `gpt-4.1`) collapse together; Bedrock and the provider's own API stay apart, since
 * those are two backends with their own price rows.
 */
export const pricingRowKey = (model: ModelInfo): string => `${model.backend}:${normalizeModelsDevKey(model.id)}`;

const hasPrice = (model: ModelInfo): boolean =>
  Object.values(model.pricing ?? {}).some(tier => tier && (tier.input > 0 || tier.output > 0));

/** One model per pricingRowKey, in first-seen order; a priced row wins over an unpriced twin. */
export function dedupePricingRows(models: readonly ModelInfo[]): ModelInfo[] {
  const byKey = new Map<string, ModelInfo>();
  for (const model of models) {
    const key = pricingRowKey(model);
    const kept = byKey.get(key);
    if (!kept || (!hasPrice(kept) && hasPrice(model))) byKey.set(key, model);
  }
  return [...byKey.values()];
}

export const formatCreditsPer1M = (credits: number): string =>
  credits.toLocaleString(undefined, { maximumFractionDigits: 2 });

/** Input and output credits per 1M tokens, formatted; 'N/A' when the model has no price. */
export function textModelPriceCells(model: ModelInfo): { inputCost: string; outputCost: string } {
  const rates = getTextModelCreditsPer1M(model);
  if (!rates) return { inputCost: 'N/A', outputCost: 'N/A' };
  return { inputCost: formatCreditsPer1M(rates.input), outputCost: formatCreditsPer1M(rates.output) };
}
