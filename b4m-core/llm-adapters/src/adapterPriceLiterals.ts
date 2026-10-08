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
 * The one list the in-code price paths draw from: the `adapter*` collectors below, and
 * collectStaticTextModels in packages/database/src/seeds/generateModelPriceSeed.ts,
 * which generates modelPrices.seed.json. They were two hand-synced copies, and a
 * backend reaching one but not the other is a silent billing defect on that
 * provider - a model with no carried `cache_read` settles cached reads at
 * input * CACHE_READ_MULTIPLIER (see `adapterPriceTiers`).
 *
 * Ollama is absent because its listing is a live server call; BFL and the image
 * backends publish no text models. The key is a placeholder - a static table needs
 * none, but the constructors take the argument. The per-token collectors and the
 * seed filter to text models, so AWSBackend (speech-to-text only) contributes only
 * to `adapterModelIds` and `adapterBuildPricedModelIds`.
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

let cachedTables: Promise<ModelInfo[]> | undefined;
let cached: Promise<ReadonlyMap<string, IModelPriceTier>> | undefined;
let cachedLadders: Promise<ReadonlyMap<string, Readonly<Record<string, IModelPriceTier>>>> | undefined;
let cachedBuildPriced: Promise<ReadonlySet<string>> | undefined;
let cachedIds: Promise<ReadonlySet<string>> | undefined;

/** Every static table read once; the four accessors below are views of it. */
function staticModelInfo(): Promise<ModelInfo[]> {
  cachedTables ??= Promise.all(staticPriceBackends().map(backend => backend.getModelInfo())).then(tables =>
    tables.flat()
  );
  return cachedTables;
}

/**
 * Every model id the static adapter tables ship. The read path merges catalog rows
 * over these literals, so discovery must not claim their hand-set presentation
 * fields even when no seed row is in force.
 */
export async function adapterModelIds(): Promise<ReadonlySet<string>> {
  cachedIds ??= staticModelInfo().then(models => new Set(models.map(model => String(model.id))));
  return cachedIds;
}

/**
 * Every model, of any type, whose adapter literal carries a price. A superset of
 * `adapterPriceTiers`, which is per-token text only: the image, video and
 * speech-to-text literals are priced per image or per minute, so they are not a
 * trusted per-token price, but the admin queue should still say the build holds
 * one rather than call the model unpriced.
 */
export async function adapterBuildPricedModelIds(): Promise<ReadonlySet<string>> {
  cachedBuildPriced ??= staticModelInfo().then(
    models =>
      new Set(
        models.filter(model => !model.freeToRun && Object.keys(model.pricing).length > 0).map(model => String(model.id))
      )
  );
  return cachedBuildPriced;
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

/**
 * The whole tier ladder of each model `adapterPriceTiers` covers, keyed by model
 * id and then by input-token threshold. The planner writes this, not the lowest
 * tier, when it records an adapter literal as a first price row: the read path
 * replaces a model's entire pricing map with the row's, so a row carrying only
 * the base tier would bill every long prompt of a tiered model at the short rate.
 */
export async function adapterPriceLadders(): Promise<ReadonlyMap<string, Readonly<Record<string, IModelPriceTier>>>> {
  cachedLadders ??= collectLadders();
  return cachedLadders;
}

/**
 * Priced per-token text models, by threshold. A model with any tier lacking a
 * positive input or output rate is left out: it would otherwise promote on, and be
 * billed at, a placeholder that settles every call at that tier free, and the whole
 * ladder is written as one row.
 */
async function collectLadders(): Promise<ReadonlyMap<string, Readonly<Record<string, IModelPriceTier>>>> {
  const ladders = new Map<string, Readonly<Record<string, IModelPriceTier>>>();
  for (const model of await staticModelInfo()) {
    if (model.type !== 'text' || model.freeToRun) continue;
    const ladder: Record<string, IModelPriceTier> = {};
    for (const [threshold, tier] of Object.entries(model.pricing)) {
      if (Number.isFinite(Number(threshold))) ladder[threshold] = tier as IModelPriceTier;
    }
    const tiers = Object.values(ladder);
    if (tiers.length > 0 && tiers.every(tier => tier.input > 0 && tier.output > 0))
      ladders.set(String(model.id), ladder);
  }
  return ladders;
}

async function collect(): Promise<ReadonlyMap<string, IModelPriceTier>> {
  const tiers = new Map<string, IModelPriceTier>();
  for (const [id, ladder] of await adapterPriceLadders()) {
    const base = lowestOf(ladder);
    if (base) tiers.set(id, base);
  }
  return tiers;
}

function lowestOf(ladder: Readonly<Record<string, IModelPriceTier>>): IModelPriceTier | undefined {
  const thresholds = Object.keys(ladder).sort((a, b) => Number(a) - Number(b));
  return thresholds.length > 0 ? ladder[thresholds[0]] : undefined;
}
