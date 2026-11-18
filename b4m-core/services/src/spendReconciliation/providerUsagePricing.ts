import {
  getTextModelCost,
  ModelBackend,
  resolveAppliedRates,
  type IModelPriceSnapshot,
  type ModelInfo,
} from '@bike4mind/common';
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

const PER_MTOK = 1 / 1_000_000;

/**
 * Published list prices (base tier, USD per token) for models the organization is billed for that
 * the adapter tables do not ship. A catalog-only model is priced at settlement from its ModelPrice
 * row, which the poller reads from the discovery-written snapshot; these literals are the fallback
 * when that snapshot is unavailable or lacks the id. An id the adapter table starts shipping must
 * leave this map.
 */
export const USAGE_ONLY_PRICING: Record<UsageReportProvider, Record<string, ModelInfo['pricing']>> = {
  anthropic: {},
  openai: {
    'gpt-6-astra': { 272_000: { input: 10 * PER_MTOK, output: 50 * PER_MTOK, cache_read: 1 * PER_MTOK } },
    'gpt-6.1-sol': { 272_000: { input: 2 * PER_MTOK, output: 10 * PER_MTOK, cache_read: 0.1 * PER_MTOK } },
  },
};

const tables = new Map<UsageReportProvider, Promise<ModelInfo[]>>();

/**
 * The provider's static adapter price table (no network, placeholder key), then USAGE_ONLY_PRICING.
 * These are the literals the ledger falls back to; ModelPrice rows are merged on top per call by
 * withSnapshotPrices.
 *
 * Image models are kept: the usage report counts their tokens and the OpenAI image literals are
 * per-token rates. A row sums text and image tokens, so both take the image rates.
 */
function providerModels(provider: UsageReportProvider): Promise<ModelInfo[]> {
  let table = tables.get(provider);
  if (!table) {
    const backend =
      provider === 'anthropic' ? new AnthropicBackend('static-price-table') : new OpenAIBackend('static-price-table');
    const usageOnly = Object.entries(USAGE_ONLY_PRICING[provider]).map(
      ([id, pricing]) =>
        ({
          id,
          type: 'text',
          backend: provider === 'anthropic' ? ModelBackend.Anthropic : ModelBackend.OpenAI,
          pricing,
        }) as ModelInfo
    );
    table = backend
      .getModelInfo()
      .then(models => [...models.filter(model => model.type === 'text' || model.type === 'image'), ...usageOnly]);
    tables.set(provider, table);
  }
  return table;
}

/**
 * Snapshot rows win over the table: the ledger charges the ModelPrice row. An id the table lacks is
 * added as a text model for the provider's backend. Ids belonging to another provider are harmless
 * because resolveUsageModel only matches exact or date-stripped ids.
 */
function withSnapshotPrices(
  provider: UsageReportProvider,
  table: readonly ModelInfo[],
  snapshot: IModelPriceSnapshot
): ModelInfo[] {
  const priced = new Map(snapshot.rows.map(row => [row.modelId, row.pricing as ModelInfo['pricing']]));
  const merged = table.map(model => {
    const pricing = priced.get(String(model.id));
    return pricing ? ({ ...model, pricing } as ModelInfo) : model;
  });
  const known = new Set(table.map(model => String(model.id)));
  const backend = provider === 'anthropic' ? ModelBackend.Anthropic : ModelBackend.OpenAI;
  for (const [id, pricing] of priced) {
    if (!known.has(id)) merged.push({ id, type: 'text', backend, pricing } as ModelInfo);
  }
  return merged;
}

/**
 * Prices usage-report rows with our model rates, layering the optional ModelPrice snapshot over the
 * static table. A model the table cannot price is never dropped silently: its output tokens are
 * counted in `unpricedOutputTokens` and its id listed.
 */
export async function priceProviderUsage(
  provider: UsageReportProvider,
  rows: readonly ProviderHourlyUsage[],
  models?: readonly ModelInfo[],
  snapshot?: IModelPriceSnapshot
): Promise<ProviderUsagePrice> {
  const base = models ?? (await providerModels(provider));
  const table = snapshot ? withSnapshotPrices(provider, base, snapshot) : base;
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
