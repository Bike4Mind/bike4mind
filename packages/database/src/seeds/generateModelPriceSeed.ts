import {
  AnthropicBackend,
  AWSBackend,
  GeminiBackend,
  OpenAIBackend,
  REALTIME_VOICE_PRICING,
  UndifferentiatedBedrockBackend,
  XAIBackend,
} from '@bike4mind/llm-adapters';
import type { IModelPriceTier, ModelInfo, ModelPriceUnit } from '@bike4mind/common';

export interface ModelPriceSeedEntry {
  modelId: string;
  unit: ModelPriceUnit;
  pricing: Record<string, IModelPriceTier>;
}

/**
 * Text models from every backend whose getModelInfo() is a static table (no
 * network, no real key needed). Ollama is excluded: its list is a live server
 * call and its models are freeToRun.
 */
export async function collectStaticTextModels(): Promise<ModelInfo[]> {
  const backends = [
    new OpenAIBackend('seed-key'),
    new AnthropicBackend('seed-key'),
    new UndifferentiatedBedrockBackend(),
    new GeminiBackend('seed-key'),
    new XAIBackend('seed-key'),
    new AWSBackend(),
  ];
  const models = (await Promise.all(backends.map(b => b.getModelInfo()))).flat();
  return models.filter(m => m.type === 'text');
}

/**
 * The seed derives from the adapter price literals, so at generation time the
 * catalog and the literals agree by construction. The checked-in
 * modelPrices.seed.json is the reviewed audit of every price we believe; the
 * freshness test fails when an adapter price changes without regenerating it.
 */
export async function generateModelPriceSeed(): Promise<ModelPriceSeedEntry[]> {
  const models = await collectStaticTextModels();
  const textEntries = models
    .filter(m => !m.freeToRun)
    .map(m => {
      const pricing: ModelPriceSeedEntry['pricing'] = {};
      for (const [threshold, tier] of Object.entries(m.pricing)) {
        pricing[threshold] = {
          input: tier.input,
          output: tier.output,
          ...(tier.cache_read !== undefined ? { cache_read: tier.cache_read } : {}),
          ...(tier.cache_write !== undefined ? { cache_write: tier.cache_write } : {}),
        };
      }
      return { modelId: m.id as string, unit: 'per_token' as const, pricing };
    });
  // Realtime voice models are not in any getModelInfo table; their literal
  // lives in REALTIME_VOICE_PRICING and rides the same seed pipeline.
  const voiceEntries = Object.entries(REALTIME_VOICE_PRICING).map(([modelId, tier]) => ({
    modelId,
    unit: 'per_token' as const,
    pricing: { '0': { ...tier } },
  }));
  return [...textEntries, ...voiceEntries].sort((a, b) => a.modelId.localeCompare(b.modelId));
}
