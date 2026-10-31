import { getTextModelCost, resolveAppliedRates, type ModelInfo } from '@bike4mind/common';
import { AnthropicBackend, OpenAIBackend } from '@bike4mind/llm-adapters';
import type { ProviderHourlyUsage } from './providerUsageFetchers';

/** Provider names as llmUsageSettledLog.ts spells them, so both spend metrics share a Provider dimension. */
export type UsageReportProvider = 'anthropic' | 'openai';

export interface ProviderUsagePrice {
  usd: number;
  outputTokens: number;
  unpricedOutputTokens: number;
  unpricedModels: string[];
}

// Usage reports name dated snapshots (claude-opus-4-5-20251101, gpt-4o-2024-08-06) while the
// catalog carries a mix of aliases and snapshots, so ids are also compared with the date dropped.
const SNAPSHOT_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;
const withoutSnapshot = (id: string) => id.replace(SNAPSHOT_SUFFIX, '');

/** Exact id first, then the same model with its snapshot date dropped on either side. */
export function resolveUsageModel(modelId: string, models: readonly ModelInfo[]): ModelInfo | undefined {
  const exact = models.find(model => model.id === modelId);
  if (exact) return exact;
  const base = withoutSnapshot(modelId);
  return models.find(model => model.id === base) ?? models.find(model => withoutSnapshot(String(model.id)) === base);
}

const tables = new Map<UsageReportProvider, Promise<ModelInfo[]>>();

/**
 * The provider's static adapter price table (no network, placeholder key). These are the literals
 * the ledger falls back to; a ModelPrice catalog row overriding one is not seen here.
 */
function providerModels(provider: UsageReportProvider): Promise<ModelInfo[]> {
  let table = tables.get(provider);
  if (!table) {
    const backend =
      provider === 'anthropic' ? new AnthropicBackend('static-price-table') : new OpenAIBackend('static-price-table');
    table = backend.getModelInfo().then(models => models.filter(model => model.type === 'text'));
    tables.set(provider, table);
  }
  return table;
}

/**
 * Prices usage-report rows with our model rates. A model the table cannot price is never dropped
 * silently: its output tokens are counted in `unpricedOutputTokens` and its id listed.
 */
export async function priceProviderUsage(
  provider: UsageReportProvider,
  rows: readonly ProviderHourlyUsage[],
  models?: readonly ModelInfo[]
): Promise<ProviderUsagePrice> {
  const table = models ?? (await providerModels(provider));
  const unpriced = new Set<string>();
  let usd = 0;
  let outputTokens = 0;
  let unpricedOutputTokens = 0;

  for (const row of rows) {
    outputTokens += row.outputTokens;
    const model = resolveUsageModel(row.model, table);
    if (!model || model.freeToRun || !resolveAppliedRates(model, 0)) {
      if (!model?.freeToRun) {
        unpricedOutputTokens += row.outputTokens;
        unpriced.add(row.model);
      }
      continue;
    }
    // A bucket sums many requests, so its total says nothing about any one prompt's size; the base
    // tier (basis 0) keeps a long-context surcharge from applying to the whole hour.
    usd += getTextModelCost(model, row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens, 0);
  }

  return { usd, outputTokens, unpricedOutputTokens, unpricedModels: [...unpriced].sort() };
}
