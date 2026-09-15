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
 * The prices this build ships in code, keyed by model id.
 *
 * Same provenance as packages/database's modelPrices.seed.json - the adapter
 * `getModelInfo()` literals - reachable without a database, which is what the
 * price planner needs: a model's FIRST discovery-written row has no row in force
 * to carry the rates no feed publishes from, and a tier that reaches
 * getTextModelCost without `cache_read` settles cached reads at
 * input * CACHE_READ_MULTIPLIER. On DeepSeek Flash that default is 0.03/1M
 * against a real 0.006/1M. MUST STAY IN SYNC with collectStaticTextModels in
 * packages/database/src/seeds/generateModelPriceSeed.ts: both lists are "every
 * backend whose getModelInfo() is a static table", and Ollama is absent from
 * both because its listing is a live server call.
 */
const STATIC_PRICE_BACKENDS = () => [
  new OpenAIBackend('price-literal'),
  new AnthropicBackend('price-literal'),
  new UndifferentiatedBedrockBackend(),
  new GeminiBackend('price-literal'),
  new XAIBackend('price-literal'),
  new KimiBackend('price-literal'),
  new DeepSeekBackend('price-literal'),
  new AWSBackend(),
];

let cached: Promise<ReadonlyMap<string, IModelPriceTier>> | undefined;

/**
 * The lowest-threshold tier of each priced text model's adapter literal.
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
  const tables = await Promise.all(STATIC_PRICE_BACKENDS().map(backend => backend.getModelInfo()));
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
