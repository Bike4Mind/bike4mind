import { getTextModelCreditsPer1M, ModelBackend, normalizeModelsDevKey, type ModelInfo } from '@bike4mind/common';

const BEDROCK_VERSION_SUFFIX = /-v\d+(?::\d+)?$/;

/**
 * One key per model per backend. A dated snapshot and its alias (`gpt-4.1-2025-04-14` and a
 * discovered `gpt-4.1`) collapse together; Bedrock and the provider's own API stay apart, since
 * those are two backends with their own price rows, and so do Bedrock model versions (`-v1:0`
 * vs `-v2:0`), which are different models.
 */
export const pricingRowKey = (model: ModelInfo): string =>
  `${model.backend}:${normalizeModelsDevKey(model.id)}${model.id.match(BEDROCK_VERSION_SUFFIX)?.[0] ?? ''}`;

const priceSignature = (model: ModelInfo): string | null => {
  const rates = getTextModelCreditsPer1M(model);
  if (rates) return `${rates.input}/${rates.output}`;
  const priced = Object.values(model.pricing ?? {}).some(tier => tier && (tier.input > 0 || tier.output > 0));
  return priced ? JSON.stringify(model.pricing) : null;
};

/**
 * One row per pricingRowKey and price, in first-seen order. An unpriced twin gives way to a priced
 * one, but twins at different prices (an older snapshot billed at its own rate) both stay. Bedrock
 * region profiles of one model (`us.`, `eu.`, `global.`) are one row whatever their rates, and a
 * row that would read identically to a kept one (same backend, name and price) is dropped.
 */
export function dedupePricingRows(models: readonly ModelInfo[]): ModelInfo[] {
  const byKey = new Map<string, ModelInfo[]>();
  for (const model of models) {
    const key = pricingRowKey(model);
    const kept = byKey.get(key) ?? [];
    const signature = priceSignature(model);
    const keptSignatures = kept.map(priceSignature);
    if (signature === null) {
      if (kept.length === 0) byKey.set(key, [model]);
      continue;
    }
    if (model.backend === ModelBackend.Bedrock && kept.some((_, i) => keptSignatures[i] !== null)) continue;
    if (keptSignatures.includes(signature)) continue;
    byKey.set(key, [...kept.filter((_, i) => keptSignatures[i] !== null), model]);
  }

  const seen = new Set<string>();
  return [...byKey.values()].flat().filter(model => {
    const visible = `${model.backend}|${model.name}|${priceSignature(model)}`;
    if (seen.has(visible)) return false;
    seen.add(visible);
    return true;
  });
}

export const formatCreditsPer1M = (credits: number): string =>
  credits.toLocaleString(undefined, { maximumFractionDigits: 2 });

/** Input and output credits per 1M tokens, formatted; 'N/A' when the model has no price. */
export function textModelPriceCells(model: ModelInfo): { inputCost: string; outputCost: string } {
  const rates = getTextModelCreditsPer1M(model);
  if (!rates) return { inputCost: 'N/A', outputCost: 'N/A' };
  return { inputCost: formatCreditsPer1M(rates.input), outputCost: formatCreditsPer1M(rates.output) };
}
