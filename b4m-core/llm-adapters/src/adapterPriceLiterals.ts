import type { IModelPriceTier, ModelInfo } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';
import { AWSBackend } from './awsBackend';
import { UndifferentiatedBedrockBackend } from './bedrockBackend/undifferentiated';
import { DeepSeekBackend } from './deepseekBackend';
import { GeminiBackend } from './geminiBackend';
import { KimiBackend } from './kimiBackend';
import { OpenAIBackend } from './openaiBackend';
import { XAIBackend } from './xaiBackend';

/**
 * Every backend whose `getModelInfo()` is a static table - no network, no real key.
 *
 * The one list both in-code price paths draw from: `adapterPriceTiers` below, and
 * collectStaticTextModels in packages/database/src/seeds/generateModelPriceSeed.ts,
 * which generates modelPrices.seed.json. They were two hand-synced copies, and a
 * backend reaching one but not the other is a silent billing defect on that
 * provider - a model with no carried `cache_read` settles cached reads at
 * input * CACHE_READ_MULTIPLIER (see `adapterPriceTiers`).
 *
 * Ollama is absent because its listing is a live server call; BFL and the image
 * backends publish no text models. The key is a placeholder - a static table needs
 * none, but the constructors take the argument. Both consumers filter to text
 * models, so AWSBackend (speech-to-text only) contributes nothing today.
 */
export const staticPriceBackends = () => [
  new OpenAIBackend('static-price-table'),
  new AnthropicBackend('static-price-table'),
  new UndifferentiatedBedrockBackend(),
  new GeminiBackend('static-price-table'),
  new XAIBackend('static-price-table'),
  new KimiBackend('static-price-table'),
  new DeepSeekBackend('static-price-table'),
  new AWSBackend(),
];

let cached: Promise<ReadonlyMap<string, IModelPriceTier>> | undefined;
let cachedIds: Promise<ReadonlySet<string>> | undefined;

/**
 * Every model id the static adapter tables ship. The read path merges catalog rows
 * over these literals, so discovery must not claim their hand-set presentation
 * fields even when no seed row is in force.
 */
export async function adapterModelIds(): Promise<ReadonlySet<string>> {
  cachedIds ??= Promise.all(staticPriceBackends().map(backend => backend.getModelInfo())).then(
    tables => new Set(tables.flat().map(model => String(model.id)))
  );
  return cachedIds;
}

/**
 * The prices this build ships in code: the lowest-threshold tier of each priced
 * text model's adapter literal, keyed by model id.
 *
 * Same provenance as packages/database's modelPrices.seed.json, but reachable
 * without a database, which is what the price planner needs: a model's FIRST
 * discovery-written row has no row in force to carry the rates no feed publishes
 * from, and a tier that reaches getTextModelCost without `cache_read` settles
 * cached reads at input * CACHE_READ_MULTIPLIER. On DeepSeek Flash that default
 * is 0.03/1M against a real 0.006/1M.
 *
 * Lowest tier on purpose: this is a last-resort carry for rates no feed
 * publishes (cache and audio), and those do not vary by context bracket in any
 * literal we ship, while the threshold keys of a discovered ladder need not
 * match the literal's. Memoized - the tables are static, and the planner runs
 * once per convergence pass.
 */
export async function adapterPriceTiers(): Promise<ReadonlyMap<string, IModelPriceTier>> {
  cached ??= collect();
  return cached;
}

async function collect(): Promise<ReadonlyMap<string, IModelPriceTier>> {
  const tables = await Promise.all(staticPriceBackends().map(backend => backend.getModelInfo()));
  const tiers = new Map<string, IModelPriceTier>();
  for (const model of tables.flat()) {
    if (model.type !== 'text' || model.freeToRun) continue;
    const tier = lowestTier(model);
    if (tier) tiers.set(String(model.id), tier);
  }
  return tiers;
}

function lowestTier(model: ModelInfo): IModelPriceTier | undefined {
  const thresholds = Object.keys(model.pricing)
    .map(Number)
    .filter(threshold => Number.isFinite(threshold))
    .sort((a, b) => a - b);
  const tier = thresholds.length > 0 ? model.pricing[thresholds[0]] : undefined;
  return tier as IModelPriceTier | undefined;
}
